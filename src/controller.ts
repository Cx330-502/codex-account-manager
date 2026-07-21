import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import * as vscode from "vscode";

import { ApiService } from "./api";
import {
  deriveAccountIdentity,
  getAccountLabel,
  quoteForShell,
} from "./auth";
import { CodexAccountStore } from "./store";
import type {
  AccountRecord,
  ApiConfigFile,
  CodexAuthFile,
  ManagedAccount,
  RuntimeState,
  SharedStateInfo,
} from "./types";
import {
  encodeUsageFailure,
  formatUsageFailureSummary,
  toUsageFailureInfo,
  type UsageFailureKind,
} from "./usageFailure";
import { UsageService, type UsageFetchResult } from "./usage";

export interface ControllerState {
  accounts: ManagedAccount[];
  currentWindowAccount: CurrentWindowAccountState;
  liveApiAccount: ManagedAccount | null;
  sharedState: SharedStateInfo;
  restart: RestartState;
  lastError: string | null;
}

export interface CurrentWindowAccountState {
  accountId: string | null;
  label: string | null;
  account: ManagedAccount | null;
}

interface RefreshUsageOptions {
  reason?: "manual" | "background";
}

export interface RestartState {
  thisWindowNeedsReload: boolean;
  canRevertToWindowAccount: boolean;
  currentWindowAccountId: string | null;
  currentWindowAccountLabel: string | null;
  liveAccountId: string | null;
  liveAccountLabel: string | null;
  switchedAt: string | null;
  pendingWindowCount: number;
}

const FILE_WATCH_INTERVAL_MS = 1500;
const HEARTBEAT_INTERVAL_MS = 30_000;
const AUTO_REFRESH_TICK_MS = 60_000;
const AUTO_REFRESH_LEASE_MS = 2 * 60_000;
const AUTO_REFRESH_BETWEEN_ACCOUNT_DELAY_MS = 350;
const AUTO_REFRESH_RETRY_DELAY_MS = 15_000;
const BACKGROUND_REFRESH_MAX_ATTEMPTS = 3;
const BACKGROUND_FAILURE_REPORT_THRESHOLD = 5;
const REFRESH_RECOVERY_DELAY_MS = 1_000;

export class CodexAccountsController implements vscode.Disposable {
  private readonly onDidChangeStateEmitter = new vscode.EventEmitter<ControllerState>();
  private readonly windowId: string;

  public readonly onDidChangeState = this.onDidChangeStateEmitter.event;

  private watchDebounce: NodeJS.Timeout | undefined;
  private registryWatchDebounce: NodeJS.Timeout | undefined;
  private refreshRecoveryTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private autoRefreshTimer: NodeJS.Timeout | undefined;
  private initialAutoRefreshTimer: NodeJS.Timeout | undefined;
  private backgroundUsageRefreshInFlight = false;
  private readonly backgroundFailureCounts = new Map<string, number>();
  private disposed = false;
  private pendingReloginAccountId: string | null = null;
  private state: ControllerState;

  public constructor(
    private readonly store: CodexAccountStore,
    private readonly usageService: UsageService,
    private readonly apiService: ApiService,
    windowId: string = randomUUID(),
  ) {
    this.windowId = windowId;
    this.state = {
      accounts: [],
      currentWindowAccount: emptyCurrentWindowAccountState(),
      liveApiAccount: null,
      sharedState: this.store.getSharedStateInfo(),
      restart: emptyRestartState(),
      lastError: null,
    };
  }

  public getState(): ControllerState {
    return this.state;
  }

  public async initialize(): Promise<void> {
    await this.store.ensureReady();
    const accounts = await this.store.listAccounts();
    const currentAuth = await this.store.readCurrentAuth();
    const liveAuthState = describeLiveAuth(accounts, currentAuth);
    await this.store.registerWindowSession(this.windowId, liveAuthState.accountId);
    await this.refresh(false);
    this.startWatchingFiles();
    this.startIntervals();
    this.scheduleInitialAutoRefresh();
  }

  public dispose(): void {
    this.disposed = true;
    if (this.watchDebounce) {
      clearTimeout(this.watchDebounce);
    }
    if (this.registryWatchDebounce) {
      clearTimeout(this.registryWatchDebounce);
    }
    if (this.refreshRecoveryTimer) {
      clearTimeout(this.refreshRecoveryTimer);
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
    }
    if (this.initialAutoRefreshTimer) {
      clearTimeout(this.initialAutoRefreshTimer);
    }
    fs.unwatchFile(this.store.authPath);
    fs.unwatchFile(this.store.registryPath);
    void this.store.removeWindowSession(this.windowId);
    this.onDidChangeStateEmitter.dispose();
  }

  public async refresh(triggerUsage: boolean | undefined = undefined): Promise<void> {
    try {
      const accounts = await this.store.listAccounts();
      const currentAuth = await this.store.readCurrentAuth();
      const liveApiAccount = await this.buildLiveApiAccountState(accounts);
      const runtime = await this.store.getRuntimeState();
      const liveAuthState = describeLiveAuth(accounts, currentAuth);
      const restart = this.buildRestartState(accounts, runtime, liveAuthState);
      this.updateState({
        accounts,
        currentWindowAccount: this.buildCurrentWindowAccountState(
          accounts,
          restart,
          liveAuthState,
        ),
        liveApiAccount,
        sharedState: this.store.getSharedStateInfo(),
        restart,
        lastError: null,
      });
      if (this.refreshRecoveryTimer) {
        clearTimeout(this.refreshRecoveryTimer);
        this.refreshRecoveryTimer = undefined;
      }

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
      this.scheduleRefreshRecovery();
      this.updateState({
        accounts: this.state.accounts,
        currentWindowAccount: this.state.currentWindowAccount,
        liveApiAccount: this.state.liveApiAccount,
        sharedState: this.store.getSharedStateInfo(),
        restart: this.state.restart,
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

    await this.switchToManagedAccount(account);
  }

  public async switchApiAccount(target?: AccountTarget): Promise<void> {
    const account = await this.resolveApiAccount(target, "Select an API account to switch to");
    if (!account) {
      return;
    }

    await this.switchToManagedAccount(account);
  }

  private async switchToManagedAccount(account: ManagedAccount): Promise<void> {
    const accounts = await this.store.listAccounts();
    const previousActiveAccount =
      accounts.find((entry) => entry.isActive && entry.record.kind === "auth")?.record.id ?? null;
    await this.store.switchToAccount(account.record.id);
    if (account.record.kind === "auth") {
      await this.store.recordSwitch(previousActiveAccount, account.record.id);
    }
    await this.refresh(false);
    if (account.record.kind === "auth") {
      void this.refreshUsage(account.record.id, {
        reason: "background",
      });
    }

    if (account.record.kind === "auth") {
      vscode.window.showInformationMessage(
        `Switched Codex auth.json to ${getAccountLabel(account.record)}. Existing windows should reload before new Codex runs use the new account.`,
      );
      return;
    }

    const action = await vscode.window.showInformationMessage(
      `Switched live API config to ${getAccountLabel(account.record)} at ${this.store.apiConfigPath}. Reload this window to ensure new runs pick it up.`,
      "Reload Window",
    );
    if (action === "Reload Window") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
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

  public async addApiAccount(): Promise<void> {
    const draft = await this.promptForApiConfig();
    if (!draft) {
      return;
    }

    const result = await this.validateApiDraft(draft);
    const record = await this.store.createApiAccount(result.config, "manual");
    await this.store.setApiHealth(record.id, result.config, result.health, result.healthError);
    await this.refresh(false);
    vscode.window.showInformationMessage(
      result.healthError
        ? `Saved API account ${getAccountLabel(record)} with health check warning: ${result.healthError}`
        : `Saved API account ${getAccountLabel(record)} and fetched ${result.config.models.length} model(s).`,
    );
  }

  public async editApiAccount(target?: AccountTarget): Promise<void> {
    const account = await this.resolveApiAccount(target, "Select an API account to edit");
    if (!account) {
      return;
    }

    const currentConfig = account.payload.kind === "api" ? account.payload.api : null;
    if (!currentConfig) {
      throw new Error("Selected account does not contain an API config.");
    }

    const draft = await this.promptForApiConfig(currentConfig);
    if (!draft) {
      return;
    }

    const result = await this.validateApiDraft(draft);
    await this.store.setApiHealth(
      account.record.id,
      result.config,
      result.health,
      result.healthError,
    );
    await this.refresh(false);
    vscode.window.showInformationMessage(
      result.healthError
        ? `Updated API account ${getAccountLabel(account.record)} with health check warning: ${result.healthError}`
        : `Updated API account ${getAccountLabel(account.record)} and refreshed ${result.config.models.length} model(s).`,
    );
  }

  public async checkApiHealth(target?: AccountTarget): Promise<void> {
    const account = await this.resolveApiAccount(target, "Select an API account to check");
    if (!account) {
      return;
    }
    if (account.payload.kind !== "api") {
      return;
    }

    const result = await this.validateApiDraft(account.payload.api);
    await this.store.setApiHealth(
      account.record.id,
      result.config,
      result.health,
      result.healthError,
    );
    await this.refresh(false);
    vscode.window.showInformationMessage(
      result.healthError
        ? `API health check failed for ${getAccountLabel(account.record)}: ${result.healthError}`
        : `API health check passed for ${getAccountLabel(account.record)} with ${result.config.models.length} model(s).`,
    );
  }

  public async openLiveApiConfig(): Promise<void> {
    const apiConfigUri = vscode.Uri.file(this.store.apiConfigPath);
    try {
      await vscode.commands.executeCommand("revealFileInOS", apiConfigUri);
    } catch {
      const document = await vscode.workspace.openTextDocument(apiConfigUri);
      await vscode.window.showTextDocument(document, {
        preview: false,
      });
    }
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
    const currentRecord = await this.store.captureCurrentAuth("manual");
    this.startLoginInTerminal();

    vscode.window.showInformationMessage(
      currentRecord
        ? `Saved ${getAccountLabel(currentRecord)} first, then started a clean Codex login. After the new login updates ~/.codex/auth.json, this extension will auto-capture it.`
        : "Started a clean Codex login. After the new login updates ~/.codex/auth.json, this extension will auto-capture it.",
    );
  }

  public async reloginAccount(target?: AccountTarget): Promise<void> {
    const account = await this.resolveAccount(
      target,
      "Select an account to re-login and replace",
    );
    if (!account) {
      return;
    }
    if (account.record.kind !== "auth") {
      vscode.window.showInformationMessage("Re-login replace is only available for auth accounts.");
      return;
    }

    const accounts = await this.store.listAccounts();
    const previousActiveAccount =
      accounts.find((entry) => entry.isActive && entry.record.kind === "auth")?.record.id ?? null;
    if (!account.isActive) {
      await this.store.switchToAccount(account.record.id);
      await this.store.recordSwitch(previousActiveAccount, account.record.id);
    }

    this.pendingReloginAccountId = account.record.id;
    this.startLoginInTerminal();
    await this.refresh(false);

    vscode.window.showInformationMessage(
      `Started re-login for ${getAccountLabel(account.record)}. After login writes ~/.codex/auth.json, this entry will be replaced directly.`,
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
    const isBackgroundRefresh = (options.reason ?? "manual") === "background";
    if (isBackgroundRefresh && this.backgroundUsageRefreshInFlight) {
      return;
    }
    if (isBackgroundRefresh) {
      this.backgroundUsageRefreshInFlight = true;
    }

    try {
      const accounts = await this.store.listAccounts();
      const targetId = getAccountTargetId(target);
      const targetAccounts = (targetId
        ? accounts.filter((account) => account.record.id === targetId)
        : accounts).filter((account) => account.record.kind === "auth");
    if (targetAccounts.length === 0) {
      if (!isBackgroundRefresh) {
        vscode.window.showInformationMessage(
          "Usage refresh is only available for auth-based accounts.",
        );
      }
      return;
    }
    const minIntervalMinutes = isBackgroundRefresh
      ? getUsageRefreshMinIntervalMinutes()
      : 0;
    const minIntervalMs = minIntervalMinutes * 60_000;
    const shouldNotify = !isBackgroundRefresh;
    let refreshedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let firstSkippedAccount: ManagedAccount | null = null;
    let firstFailureMessage: string | null = null;
    let firstFailureKind: UsageFailureKind | null = null;

    for (const [index, account] of targetAccounts.entries()) {
      if (isBackgroundRefresh && index > 0) {
        await sleep(AUTO_REFRESH_BETWEEN_ACCOUNT_DELAY_MS);
      }
      if (shouldSkipUsageRefresh(account.record, minIntervalMs)) {
        skippedCount += 1;
        firstSkippedAccount ??= account;
        continue;
      }

      try {
        if (account.payload.kind !== "auth") {
          continue;
        }
        const result = await this.fetchUsageWithRetry(
          account.payload.auth,
          isBackgroundRefresh,
        );
        this.backgroundFailureCounts.delete(account.record.id);
        if (result.authRefreshed) {
          await this.store.updateAccountAuth(account.record.id, result.auth);
        }
        await this.store.setUsage(account.record.id, result.usage, null);
        refreshedCount += 1;
      } catch (error) {
        const errorMessage = toErrorMessage(error);
        const shouldPersistFailure =
          !isBackgroundRefresh ||
          this.bumpBackgroundFailureCount(account.record.id) >=
            BACKGROUND_FAILURE_REPORT_THRESHOLD;
        if (shouldPersistFailure) {
          await this.store.setUsage(
            account.record.id,
            undefined,
            encodeUsageFailure(errorMessage),
          );
        }
        failedCount += 1;
        firstFailureMessage ??= errorMessage;
        firstFailureKind ??= toUsageFailureInfo(errorMessage).kind;
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
      const failureMessage = formatUsageFailureMessage(
        firstFailureKind,
        firstFailureMessage,
      );
      if (firstFailureKind === "network") {
        const decision = await vscode.window.showWarningMessage(
          `Usage refresh failed${failureTarget}: ${failureMessage}`,
          "Reload Window",
        );
        if (decision === "Reload Window") {
          await vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      } else {
        vscode.window.showWarningMessage(
          `Usage refresh failed${failureTarget}: ${failureMessage}`,
        );
      }
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
    } finally {
      if (isBackgroundRefresh) {
        this.backgroundUsageRefreshInFlight = false;
      }
    }
  }

  private updateState(nextState: ControllerState): void {
    this.state = nextState;
    this.onDidChangeStateEmitter.fire(this.state);
  }

  private startWatchingFiles(): void {
    const autoCapture = vscode.workspace
      .getConfiguration("codexAccounts")
      .get<boolean>("autoCaptureCurrent", true);
    if (autoCapture) {
      fs.watchFile(
        this.store.authPath,
        { interval: FILE_WATCH_INTERVAL_MS },
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

    fs.watchFile(
      this.store.registryPath,
      { interval: FILE_WATCH_INTERVAL_MS },
      (currentStats, previousStats) => {
        if (this.disposed || currentStats.mtimeMs === previousStats.mtimeMs) {
          return;
        }
        this.scheduleRegistryRefresh();
      },
    );
  }

  private startIntervals(): void {
    this.heartbeatTimer = setInterval(() => {
      void this.runHeartbeatTick();
    }, HEARTBEAT_INTERVAL_MS);

    this.autoRefreshTimer = setInterval(() => {
      void this.runAutoRefreshTick();
    }, AUTO_REFRESH_TICK_MS);
  }

  private scheduleInitialAutoRefresh(): void {
    if (this.initialAutoRefreshTimer || this.disposed) {
      return;
    }

    this.initialAutoRefreshTimer = setTimeout(() => {
      this.initialAutoRefreshTimer = undefined;
      void this.runAutoRefreshTick();
    }, 250);
  }

  private async captureFromWatch(): Promise<void> {
    try {
      const currentAuth = await this.store.readCurrentAuth();
      if (!currentAuth) {
        return;
      }
      let record: AccountRecord | null;
      if (this.pendingReloginAccountId) {
        try {
          record = await this.store.replaceAccountAuth(
            this.pendingReloginAccountId,
            currentAuth,
          );
        } catch {
          record = await this.store.saveSnapshotFromAuth(currentAuth, "auto");
        }
        this.pendingReloginAccountId = null;
      } else {
        record = await this.store.saveSnapshotFromAuth(currentAuth, "auto");
      }
      await this.refresh(false);
      if (record) {
        void this.refreshUsage(record.id, {
          reason: "background",
        });
      }
    } catch {
      this.pendingReloginAccountId = null;
      // Ignore watcher errors; state refresh already surfaces persistent issues.
    }
  }

  private startLoginInTerminal(): void {
    const codexBinary = quoteForShell(this.resolveCodexBinary());
    const terminal = vscode.window.createTerminal({
      name: "Codex Login",
      cwd: this.store.codexHome,
    });
    terminal.show(true);
    terminal.sendText(`${codexBinary} logout`, true);
    terminal.sendText(`${codexBinary} login`, true);
  }

  private async fetchUsageWithRetry(
    auth: CodexAuthFile,
    isBackgroundRefresh: boolean,
  ): Promise<UsageFetchResult> {
    const maxAttempts = isBackgroundRefresh ? BACKGROUND_REFRESH_MAX_ATTEMPTS : 1;
    let attempt = 0;
    let lastError: unknown;
    while (attempt < maxAttempts) {
      try {
        return await this.usageService.fetchUsage(auth, {
          includeResetCreditDetails: !isBackgroundRefresh,
        });
      } catch (error) {
        lastError = error;
        const failureKind = toUsageFailureInfo(toErrorMessage(error)).kind;
        const canRetry =
          isBackgroundRefresh &&
          attempt + 1 < maxAttempts &&
          (failureKind === "network" || failureKind === "service");
        if (!canRetry) {
          throw error;
        }
        await sleep(AUTO_REFRESH_RETRY_DELAY_MS * (attempt + 1));
      }
      attempt += 1;
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private bumpBackgroundFailureCount(accountId: string): number {
    const nextCount = (this.backgroundFailureCounts.get(accountId) ?? 0) + 1;
    this.backgroundFailureCounts.set(accountId, nextCount);
    return nextCount;
  }

  private scheduleRegistryRefresh(): void {
    if (this.registryWatchDebounce) {
      clearTimeout(this.registryWatchDebounce);
    }
    this.registryWatchDebounce = setTimeout(() => {
      void this.refresh(false);
    }, 250);
  }

  private scheduleRefreshRecovery(): void {
    if (this.disposed) {
      return;
    }
    if (this.refreshRecoveryTimer) {
      return;
    }
    this.refreshRecoveryTimer = setTimeout(() => {
      this.refreshRecoveryTimer = undefined;
      void this.refresh(false);
    }, REFRESH_RECOVERY_DELAY_MS);
  }

  private async runAutoRefreshTick(): Promise<void> {
    if (this.disposed) {
      return;
    }

    try {
      const accounts = (await this.store.listAccounts()).filter(
        (account) => account.record.kind === "auth",
      );
      if (accounts.length === 0) {
        return;
      }

      const minIntervalMs = getUsageRefreshMinIntervalMinutes() * 60_000;
      const hasDueAccounts = accounts.some(
        (account) => !shouldSkipUsageRefresh(account.record, minIntervalMs),
      );
      if (!hasDueAccounts) {
        return;
      }

      const acquired = await this.store.tryAcquireUsageRefreshLease(
        this.windowId,
        AUTO_REFRESH_LEASE_MS,
      );
      if (!acquired) {
        return;
      }

      try {
        await this.refreshUsage(undefined, {
          reason: "background",
        });
      } finally {
        await this.store.releaseUsageRefreshLease(this.windowId);
      }
    } catch {
      // Keep background refresh silent; state refresh and usage errors remain visible.
    }
  }

  private async runHeartbeatTick(): Promise<void> {
    if (this.disposed) {
      return;
    }

    try {
      await this.store.heartbeatWindowSession(this.windowId);
      await this.refresh(false);
    } catch {
      // Ignore heartbeat refresh failures; next registry refresh will recover.
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
        label: `[${account.record.kind.toUpperCase()}] ${getAccountLabel(account.record)}`,
        description:
          account.record.kind === "auth"
            ? account.record.email ?? account.record.chatgptAccountId ?? ""
            : account.record.apiBaseUrl ?? "",
        detail: account.isActive
          ? account.record.kind === "auth"
            ? "current live auth"
            : "current live API"
          : "",
        account,
      })),
      {
        placeHolder,
      },
    );

    return pickedItem?.account ?? null;
  }

  private async resolveApiAccount(
    target: AccountTarget,
    placeHolder: string,
  ): Promise<ManagedAccount | null> {
    const account = await this.resolveAccount(target, placeHolder);
    if (!account) {
      return null;
    }
    if (account.record.kind !== "api") {
      vscode.window.showInformationMessage("This action only applies to API accounts.");
      return null;
    }
    return account;
  }

  private async promptForApiConfig(
    initial?: Partial<ApiConfigFile>,
  ): Promise<Pick<ApiConfigFile, "baseUrl" | "apiKey"> | null> {
    const baseUrl = await vscode.window.showInputBox({
      prompt: "API base URL",
      placeHolder: "https://api.openai.com",
      value: initial?.baseUrl ?? "",
      ignoreFocusOut: true,
    });
    if (baseUrl === undefined) {
      return null;
    }

    const apiKey = await vscode.window.showInputBox({
      prompt: "API key",
      password: true,
      value: initial?.apiKey ?? "",
      ignoreFocusOut: true,
    });
    if (apiKey === undefined) {
      return null;
    }

    return {
      baseUrl,
      apiKey,
    };
  }

  private async validateApiDraft(
    draft: Pick<ApiConfigFile, "baseUrl" | "apiKey">,
  ): Promise<{
    config: ApiConfigFile;
    health: AccountRecord["health"] | undefined;
    healthError: string | null;
  }> {
    try {
      const result = await this.apiService.validateAndHydrateConfig(draft);
      return {
        config: result.config,
        health: result.health,
        healthError: null,
      };
    } catch (error) {
      return {
        config: {
          baseUrl: draft.baseUrl.trim(),
          apiKey: draft.apiKey.trim(),
          models: [],
        },
        health: undefined,
        healthError: toErrorMessage(error),
      };
    }
  }

  private async buildLiveApiAccountState(
    accounts: ManagedAccount[],
  ): Promise<ManagedAccount | null> {
    const liveApi = await this.store.readLiveApiConfig();
    if (!liveApi?.currentAccountId) {
      return null;
    }

    return (
      accounts.find((account) => account.record.id === liveApi.currentAccountId) ?? null
    );
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

  private buildRestartState(
    accounts: ManagedAccount[],
    runtime: RuntimeState,
    liveAuthState: LiveAuthState,
  ): RestartState {
    const session = runtime.windowSessions.find((entry) => entry.id === this.windowId) ?? null;
    const currentWindowAccountId =
      session?.runtimeAccountId ??
      this.state.currentWindowAccount.accountId ??
      liveAuthState.accountId;
    const thisWindowNeedsReload = currentWindowAccountId !== liveAuthState.accountId;
    const canRevertToWindowAccount =
      thisWindowNeedsReload &&
      currentWindowAccountId != null &&
      accounts.some((account) => account.record.id === currentWindowAccountId);
    const switchedAt =
      runtime.lastSwitch?.nextAccountId === liveAuthState.accountId
        ? runtime.lastSwitch?.switchedAt ?? null
        : null;

    return {
      thisWindowNeedsReload,
      canRevertToWindowAccount,
      currentWindowAccountId,
      currentWindowAccountLabel: getAccountLabelById(accounts, currentWindowAccountId),
      liveAccountId: liveAuthState.accountId,
      liveAccountLabel: liveAuthState.label,
      switchedAt,
      pendingWindowCount: Math.max(
        runtime.windowSessions.filter(
          (entry) => entry.runtimeAccountId !== liveAuthState.accountId,
        ).length,
        thisWindowNeedsReload ? 1 : 0,
      ),
    };
  }

  private buildCurrentWindowAccountState(
    accounts: ManagedAccount[],
    restart: RestartState,
    liveAuthState: LiveAuthState,
  ): CurrentWindowAccountState {
    const accountId = restart.currentWindowAccountId ?? liveAuthState.accountId;
    const account =
      accountId != null
        ? accounts.find((entry) => entry.record.id === accountId) ?? null
        : null;

    return {
      accountId,
      label:
        account != null
          ? getAccountLabel(account.record)
          : restart.currentWindowAccountLabel ?? liveAuthState.label,
      account,
    };
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

function emptyRestartState(): RestartState {
  return {
    thisWindowNeedsReload: false,
    canRevertToWindowAccount: false,
    currentWindowAccountId: null,
    currentWindowAccountLabel: null,
    liveAccountId: null,
    liveAccountLabel: null,
    switchedAt: null,
    pendingWindowCount: 0,
  };
}

function emptyCurrentWindowAccountState(): CurrentWindowAccountState {
  return {
    accountId: null,
    label: null,
    account: null,
  };
}

function getAccountLabelById(
  accounts: ManagedAccount[],
  accountId: string | null,
): string | null {
  if (!accountId) {
    return null;
  }
  const matchedAccount = accounts.find((account) => account.record.id === accountId);
  return matchedAccount ? getAccountLabel(matchedAccount.record) : accountId;
}

interface LiveAuthState {
  accountId: string | null;
  label: string | null;
}

function describeLiveAuth(
  accounts: ManagedAccount[],
  auth: CodexAuthFile | null,
): LiveAuthState {
  if (!auth) {
    return {
      accountId: null,
      label: "signed-out auth",
    };
  }

  const identity = deriveAccountIdentity(auth);
  const managedLabel = getAccountLabelById(accounts, identity.fingerprint);
  return {
    accountId: identity.fingerprint,
    label:
      managedLabel ??
      identity.email ??
      identity.name ??
      identity.chatgptAccountId ??
      identity.accountId ??
      identity.subject ??
      "unmanaged auth",
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatUsageFailureMessage(
  kind: UsageFailureKind | null,
  rawMessage: string | null,
): string {
  if (!rawMessage) {
    switch (kind) {
      case "auth":
        return "认证过期或无效：请重新登录 codex。";
      case "network":
        return "网络错误：请检查网络后重试。";
      case "service":
        return "服务异常或限流：请稍后重试。";
      default:
        return "未知错误";
    }
  }
  return formatUsageFailureSummary(rawMessage);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
