import * as fs from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import { getAccountLabel, quoteForShell } from "./auth";
import { CodexAccountStore } from "./store";
import type { AccountRecord, ManagedAccount, SharedStateInfo } from "./types";
import { UsageService } from "./usage";

export interface ControllerState {
  accounts: ManagedAccount[];
  sharedState: SharedStateInfo;
  lastError: string | null;
}

interface RefreshUsageOptions {
  reason?: "manual" | "background";
}

export class CodexAccountsController implements vscode.Disposable {
  private readonly onDidChangeStateEmitter = new vscode.EventEmitter<ControllerState>();

  public readonly onDidChangeState = this.onDidChangeStateEmitter.event;

  private watchDebounce: NodeJS.Timeout | undefined;
  private disposed = false;
  private state: ControllerState;

  public constructor(
    private readonly store: CodexAccountStore,
    private readonly usageService: UsageService,
  ) {
    this.state = {
      accounts: [],
      sharedState: this.store.getSharedStateInfo(),
      lastError: null,
    };
  }

  public getState(): ControllerState {
    return this.state;
  }

  public async initialize(): Promise<void> {
    await this.store.ensureReady();
    await this.refresh(false);
    this.startWatchingAuthFile();
  }

  public dispose(): void {
    this.disposed = true;
    if (this.watchDebounce) {
      clearTimeout(this.watchDebounce);
    }
    fs.unwatchFile(this.store.authPath);
    this.onDidChangeStateEmitter.dispose();
  }

  public async refresh(triggerUsage: boolean | undefined = undefined): Promise<void> {
    try {
      const accounts = await this.store.listAccounts();
      this.updateState({
        accounts,
        sharedState: this.store.getSharedStateInfo(),
        lastError: null,
      });

      const shouldTriggerUsage =
        triggerUsage ??
        vscode.workspace
          .getConfiguration("codexAccounts")
          .get<boolean>("autoRefreshUsageOnRefresh", true);
      if (shouldTriggerUsage && accounts.length > 0) {
        void this.refreshUsage(undefined, {
          reason: "background",
        });
      }
    } catch (error) {
      this.updateState({
        accounts: [],
        sharedState: this.store.getSharedStateInfo(),
        lastError: toErrorMessage(error),
      });
    }
  }

  public async saveCurrentAccount(): Promise<void> {
    const record = await this.store.captureCurrentAuth("manual");
    if (!record) {
      throw new Error(`No auth.json found at ${this.store.authPath}`);
    }

    await this.refresh(false);
    vscode.window.showInformationMessage(
      `Saved current Codex account: ${getAccountLabel(record)}`,
    );
  }

  public async switchAccount(target?: AccountTarget): Promise<void> {
    const account = await this.resolveAccount(target, "Select an account to switch to");
    if (!account) {
      return;
    }

    await this.store.switchToAccount(account.record.id);
    await this.refresh(false);
    void this.refreshUsage(account.record.id, {
      reason: "background",
    });

    vscode.window.showInformationMessage(
      `Switched Codex auth.json to ${getAccountLabel(account.record)}. sessions/memories stayed shared.`,
    );
  }

  public async removeAccount(target?: AccountTarget): Promise<void> {
    const account = await this.resolveAccount(target, "Select an account to remove");
    if (!account) {
      return;
    }

    const decision = await vscode.window.showWarningMessage(
      `Remove managed snapshot for ${getAccountLabel(account.record)}?`,
      { modal: true },
      "Remove",
    );
    if (decision !== "Remove") {
      return;
    }

    await this.store.removeAccount(account.record.id);
    await this.refresh(false);
  }

  public async renameAccount(target?: AccountTarget): Promise<void> {
    const account = await this.resolveAccount(target, "Select an account to rename");
    if (!account) {
      return;
    }

    const nextLabel = await vscode.window.showInputBox({
      prompt: "Custom label for this managed account",
      value: account.record.label ?? account.record.email ?? "",
      ignoreFocusOut: true,
    });
    if (nextLabel === undefined) {
      return;
    }

    await this.store.renameAccount(account.record.id, nextLabel);
    await this.refresh(false);
  }

  public async importBundle(): Promise<void> {
    const [bundleUri] =
      (await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: {
          JSON: ["json"],
        },
        openLabel: "Import Codex account bundle",
      })) ?? [];
    if (!bundleUri) {
      return;
    }

    const importedCount = await this.store.importBundle(bundleUri.fsPath);
    await this.refresh(false);
    vscode.window.showInformationMessage(
      `Imported ${importedCount} managed account snapshot(s).`,
    );
  }

  public async exportBundle(): Promise<void> {
    const fileName = `codex-accounts-${new Date().toISOString().slice(0, 10)}.json`;
    const defaultUri = vscode.Uri.file(path.join(this.store.codexHome, fileName));
    const bundleUri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: {
        JSON: ["json"],
      },
      saveLabel: "Export Codex account bundle",
    });
    if (!bundleUri) {
      return;
    }

    const exportedCount = await this.store.exportBundle(bundleUri.fsPath);
    vscode.window.showInformationMessage(
      `Exported ${exportedCount} managed account snapshot(s).`,
    );
  }

  public async startLogin(): Promise<void> {
    await this.store.captureCurrentAuth("manual");

    const commandLine = `${quoteForShell(this.resolveCodexBinary())} login`;
    const terminal = vscode.window.createTerminal({
      name: "Codex Login",
      cwd: this.store.codexHome,
    });
    terminal.show(true);
    terminal.sendText(commandLine, true);

    vscode.window.showInformationMessage(
      "After the new login updates ~/.codex/auth.json, this extension will auto-capture it.",
    );
  }

  public async openCodexHome(): Promise<void> {
    const codexHomeUri = vscode.Uri.file(this.store.codexHome);
    try {
      await vscode.commands.executeCommand("revealFileInOS", codexHomeUri);
    } catch {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(this.store.authPath),
      );
      await vscode.window.showTextDocument(document, {
        preview: false,
      });
    }
  }

  public async refreshUsage(
    target?: AccountTarget,
    options: RefreshUsageOptions = {},
  ): Promise<void> {
    const accounts = await this.store.listAccounts();
    const targetId = getAccountTargetId(target);
    const targetAccounts = targetId
      ? accounts.filter((account) => account.record.id === targetId)
      : accounts;
    const minIntervalMinutes = getUsageRefreshMinIntervalMinutes();
    const minIntervalMs = minIntervalMinutes * 60_000;
    const shouldNotify = (options.reason ?? "manual") !== "background";
    let refreshedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let firstSkippedAccount: ManagedAccount | null = null;
    let firstFailureMessage: string | null = null;

    for (const account of targetAccounts) {
      if (shouldSkipUsageRefresh(account.record, minIntervalMs)) {
        skippedCount += 1;
        firstSkippedAccount ??= account;
        continue;
      }

      try {
        const usage = await this.usageService.fetchUsage(account.auth);
        await this.store.setUsage(account.record.id, usage, null);
        refreshedCount += 1;
      } catch (error) {
        await this.store.setUsage(account.record.id, undefined, toErrorMessage(error));
        failedCount += 1;
        firstFailureMessage ??= toErrorMessage(error);
      }
    }

    await this.refresh(false);

    if (!shouldNotify) {
      return;
    }

    if (failedCount > 0 && refreshedCount === 0 && skippedCount === 0) {
      const failureTarget =
        targetAccounts.length === 1
          ? ` for ${getAccountLabel(targetAccounts[0].record)}`
          : "";
      vscode.window.showWarningMessage(
        `Usage refresh failed${failureTarget}: ${firstFailureMessage ?? "unknown error"}`,
      );
      return;
    }

    if (
      skippedCount > 0 &&
      refreshedCount === 0 &&
      failedCount === 0 &&
      targetAccounts.length === 1 &&
      firstSkippedAccount
    ) {
      const lastCheckedAt = getUsageCheckedAt(firstSkippedAccount.record);
      const ageText = lastCheckedAt ? formatElapsedTime(lastCheckedAt) : "recently";
      vscode.window.showInformationMessage(
        `Skipped usage refresh for ${getAccountLabel(firstSkippedAccount.record)}; last checked ${ageText} ago to avoid rate limiting.`,
      );
      return;
    }

    const summaryParts: string[] = [];
    if (refreshedCount > 0) {
      summaryParts.push(`refreshed ${refreshedCount}`);
    }
    if (skippedCount > 0) {
      summaryParts.push(`skipped ${skippedCount}`);
    }
    if (failedCount > 0) {
      summaryParts.push(`failed ${failedCount}`);
    }
    if (summaryParts.length > 0) {
      vscode.window.showInformationMessage(
        `Usage refresh finished: ${summaryParts.join(", ")}. Cooldown: ${minIntervalMinutes} min.`,
      );
    }
  }

  private updateState(nextState: ControllerState): void {
    this.state = nextState;
    this.onDidChangeStateEmitter.fire(this.state);
  }

  private startWatchingAuthFile(): void {
    const autoCapture = vscode.workspace
      .getConfiguration("codexAccounts")
      .get<boolean>("autoCaptureCurrent", true);
    if (!autoCapture) {
      return;
    }

    fs.watchFile(
      this.store.authPath,
      { interval: 1500 },
      (currentStats, previousStats) => {
        if (this.disposed || currentStats.mtimeMs === previousStats.mtimeMs) {
          return;
        }

        if (this.watchDebounce) {
          clearTimeout(this.watchDebounce);
        }
        this.watchDebounce = setTimeout(() => {
          void this.captureFromWatch();
        }, 400);
      },
    );
  }

  private async captureFromWatch(): Promise<void> {
    try {
      const record = await this.store.captureCurrentAuth("auto");
      await this.refresh(false);
      if (record) {
        void this.refreshUsage(record.id, {
          reason: "background",
        });
      }
    } catch {
      // Ignore watcher errors; state refresh already surfaces persistent issues.
    }
  }

  private async resolveAccount(
    target: AccountTarget,
    placeHolder: string,
  ): Promise<ManagedAccount | null> {
    const targetId = getAccountTargetId(target);
    if (targetId) {
      const accounts = await this.store.listAccounts();
      return accounts.find((account) => account.record.id === targetId) ?? null;
    }

    const accounts = await this.store.listAccounts();
    if (accounts.length === 0) {
      vscode.window.showInformationMessage("No managed Codex accounts found.");
      return null;
    }

    const pickedItem = await vscode.window.showQuickPick(
      accounts.map((account) => ({
        label: getAccountLabel(account.record),
        description:
          account.record.email ?? account.record.chatgptAccountId ?? "",
        detail: account.isActive ? "current account" : "",
        account,
      })),
      {
        placeHolder,
      },
    );

    return pickedItem?.account ?? null;
  }

  private resolveCodexBinary(): string {
    const extension = vscode.extensions.getExtension("openai.chatgpt");
    if (extension) {
      const platform = mapPlatform(process.platform);
      const arch = mapArch(process.arch);
      if (platform && arch) {
        const executableName =
          process.platform === "win32" ? "codex.exe" : "codex";
        const candidatePath = path.join(
          extension.extensionPath,
          "bin",
          `${platform}-${arch}`,
          executableName,
        );
        if (fs.existsSync(candidatePath)) {
          return candidatePath;
        }
      }
    }

    return "codex";
  }
}

type AccountTarget =
  | string
  | { id?: string }
  | { record?: { id?: string } }
  | { account?: { record?: { id?: string } } }
  | undefined;

function getAccountTargetId(target: AccountTarget): string | null {
  if (typeof target === "string") {
    return target;
  }
  if (!target || typeof target !== "object") {
    return null;
  }
  if ("id" in target && typeof target.id === "string") {
    return target.id;
  }
  if ("record" in target && typeof target.record?.id === "string") {
    return target.record.id;
  }
  if ("account" in target && typeof target.account?.record?.id === "string") {
    return target.account.record.id;
  }
  return null;
}

function mapPlatform(
  platform: NodeJS.Platform,
): "linux" | "macos" | "windows" | null {
  switch (platform) {
    case "linux":
      return "linux";
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return null;
  }
}

function mapArch(arch: string): "aarch64" | "x86_64" | null {
  switch (arch) {
    case "arm64":
      return "aarch64";
    case "x64":
      return "x86_64";
    default:
      return null;
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getUsageRefreshMinIntervalMinutes(): number {
  const configuredValue = vscode.workspace
    .getConfiguration("codexAccounts")
    .get<number>("usageRefreshMinIntervalMinutes", 10);
  if (typeof configuredValue !== "number" || Number.isNaN(configuredValue)) {
    return 10;
  }
  return Math.max(0, Math.round(configuredValue));
}

function shouldSkipUsageRefresh(
  record: AccountRecord,
  minIntervalMs: number,
): boolean {
  if (minIntervalMs <= 0) {
    return false;
  }

  const checkedAt = getUsageCheckedAt(record);
  if (!checkedAt) {
    return false;
  }

  const checkedAtMs = Date.parse(checkedAt);
  if (Number.isNaN(checkedAtMs)) {
    return false;
  }

  return Date.now() - checkedAtMs < minIntervalMs;
}

function getUsageCheckedAt(record: AccountRecord): string | null {
  return record.usageCheckedAt ?? record.usage?.fetchedAt ?? null;
}

function formatElapsedTime(timestamp: string): string {
  const timestampMs = Date.parse(timestamp);
  if (Number.isNaN(timestampMs)) {
    return "recently";
  }

  const elapsedMs = Math.max(Date.now() - timestampMs, 0);
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 1) {
    return "less than 1 minute";
  }
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes} minute${elapsedMinutes === 1 ? "" : "s"}`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours} hour${elapsedHours === 1 ? "" : "s"}`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays} day${elapsedDays === 1 ? "" : "s"}`;
}
