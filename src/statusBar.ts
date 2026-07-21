import * as vscode from "vscode";

import { getAccountLabel } from "./auth";
import type { ControllerState, CurrentWindowAccountState } from "./controller";
import { CodexAccountsController } from "./controller";
import type { ManagedAccount } from "./types";
import { toUsageFailureInfo } from "./usageFailure";

export class CodexAccountsStatusBarController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private item: vscode.StatusBarItem | undefined;
  private restartItem: vscode.StatusBarItem | undefined;
  private revertItem: vscode.StatusBarItem | undefined;

  public constructor(private readonly controller: CodexAccountsController) {
    this.createStatusBarItem();

    this.disposables.push(
      this.controller.onDidChangeState((state) => {
        this.render(state);
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("codexAccounts.statusBarAlignment")) {
          this.createStatusBarItem();
          this.render(this.controller.getState());
        }
      }),
    );
  }

  public dispose(): void {
    this.disposables.forEach((disposable) => disposable.dispose());
    this.disposables.length = 0;
    this.item?.dispose();
    this.item = undefined;
    this.restartItem?.dispose();
    this.restartItem = undefined;
    this.revertItem?.dispose();
    this.revertItem = undefined;
  }

  public render(state: ControllerState): void {
    if (!this.item) {
      return;
    }

    if (state.liveApiAccount && state.liveApiAccount.record.kind === "api") {
      this.item.text = `$(plug) ${summarizeApi(state.liveApiAccount)}`;
      this.item.tooltip = `${buildApiTooltip(state.liveApiAccount, state)}\nClick to open the full sidebar.`;
      this.item.show();
      this.renderRestartState(state);
      return;
    }

    const currentWindowAccount = state.currentWindowAccount;
    if (!currentWindowAccount.account) {
      this.item.text = "$(pulse) Quota --";
      this.item.tooltip = buildUnavailableTooltip(currentWindowAccount, state);
      this.item.show();
      this.renderRestartState(state);
      return;
    }

    const usage = summarizeUsage(currentWindowAccount.account);
    this.item.text = `$(pulse) ${usage}`;
    this.item.tooltip = `${buildTooltip(currentWindowAccount, state)}\nClick to open the full sidebar.`;
    this.item.show();
    this.renderRestartState(state);
  }

  private createStatusBarItem(): void {
    this.item?.dispose();
    this.item = vscode.window.createStatusBarItem(getAlignment(), 120);
    this.item.command = "codexAccounts.openSidebar";
    this.item.name = "Codex Accounts";

    this.restartItem?.dispose();
    this.restartItem = vscode.window.createStatusBarItem(getAlignment(), 121);
    this.restartItem.command = "codexAccounts.reloadWindow";
    this.restartItem.name = "Codex Accounts Restart";

    this.revertItem?.dispose();
    this.revertItem = vscode.window.createStatusBarItem(getAlignment(), 122);
    this.revertItem.name = "Codex Accounts Revert";
  }

  private renderRestartState(state: ControllerState): void {
    if (!this.restartItem || !this.revertItem) {
      return;
    }

    if (!state.restart.thisWindowNeedsReload) {
      this.restartItem.hide();
      this.revertItem.hide();
      return;
    }

    const currentLabel =
      state.restart.currentWindowAccountLabel ?? "current window account";
    const liveLabel = state.restart.liveAccountLabel ?? "different live auth";
    this.restartItem.text = `$(warning) Reload: using ${currentLabel} | disk ${liveLabel}`;
    this.restartItem.tooltip =
      `Current window account: ${currentLabel}\n` +
      `Disk live auth.json: ${liveLabel}\n` +
      "These differ, so this window must reload before new Codex runs follow disk auth.\n" +
      `Pending windows: ${state.restart.pendingWindowCount}\n` +
      "Click to reload this VS Code window.";
    this.restartItem.show();

    if (
      state.restart.canRevertToWindowAccount &&
      state.restart.currentWindowAccountId
    ) {
      this.revertItem.text = `$(history) Revert -> ${currentLabel}`;
      this.revertItem.tooltip =
        `Write disk auth.json back to ${currentLabel} without reloading this window.\n` +
        `Current disk live auth: ${liveLabel}.`;
      this.revertItem.command = {
        title: "Revert to Current Window Account",
        command: "codexAccounts.switchAccount",
        arguments: [state.restart.currentWindowAccountId],
      };
      this.revertItem.show();
      return;
    }

    this.revertItem.hide();
  }
}

function getAlignment(): vscode.StatusBarAlignment {
  const side = vscode.workspace
    .getConfiguration("codexAccounts")
    .get<string>("statusBarAlignment", "right");
  return side === "left" ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right;
}

function summarizeUsage(active: ManagedAccount): string {
  if (active.record.kind !== "auth") {
    return "Quota --";
  }
  const usage = active.record.usage;
  if (!usage) {
    return "Quota --";
  }

  const parts = usage.windows.flatMap((window) =>
    window.remainingPercent == null
      ? []
      : [`${window.label} ${window.remainingPercent}%`],
  );
  if (usage.resetCredits) {
    parts.push(`resets ${usage.resetCredits.availableCount}`);
  }
  if (parts.length === 0) {
    return usage.creditLabel || "Quota --";
  }

  return parts.join(" | ");
}

function summarizeApi(active: ManagedAccount): string {
  const health = active.record.health;
  if (health?.status === "healthy") {
    return `API OK | ${health.modelCount} models`;
  }
  if (active.record.healthError) {
    return "API issue";
  }
  return "API pending";
}

function buildTooltip(
  currentWindowAccount: CurrentWindowAccountState,
  state: ControllerState,
): string {
  const active = currentWindowAccount.account;
  if (!active) {
    return buildUnavailableTooltip(currentWindowAccount, state);
  }
  if (active.record.kind !== "auth") {
    return buildUnavailableTooltip(currentWindowAccount, state);
  }

  const lines: string[] = [
    `Current window: ${getAccountLabel(active.record)}`,
    "Click for switch/import/export/refresh actions.",
  ];
  if (state.restart.thisWindowNeedsReload) {
    lines.push(
      `Reload needed: current window account is ${state.restart.currentWindowAccountLabel ?? "the current window account"}.`,
    );
    lines.push(
      `Disk live auth.json is ${state.restart.liveAccountLabel ?? "a different login state"}${state.restart.switchedAt ? ` at ${state.restart.switchedAt}` : ""}.`,
    );
  }
  const usage = active.record.usage;
  if (!usage) {
    lines.push("Usage: unavailable");
    if (active.record.usageError) {
      const failure = toUsageFailureInfo(active.record.usageError);
      lines.push(`Refresh error type: ${failure.typeLabel}`);
      lines.push(`Refresh error detail: ${failure.detail}`);
    }
    return lines.join("\n");
  }
  for (const window of usage.windows) {
    lines.push(
      `${window.label} remaining: ${window.remainingPercent ?? "--"}%${window.resetsAt ? `; resets ${window.resetsAt}` : ""}`,
    );
  }
  if (usage.resetCredits) {
    lines.push(`Rate-limit reset credits: ${usage.resetCredits.availableCount}`);
    if (usage.resetCredits.nextExpiresAt) {
      lines.push(`Next reset credit expiry: ${usage.resetCredits.nextExpiresAt}`);
    }
  }
  if (active.record.usageError) {
    const failure = toUsageFailureInfo(active.record.usageError);
    lines.push(`Refresh error type: ${failure.typeLabel}`);
    lines.push(`Refresh error detail: ${failure.detail}`);
  }
  return lines.join("\n");
}

function buildApiTooltip(active: ManagedAccount, state: ControllerState): string {
  const lines: string[] = [
    `Live API: ${getAccountLabel(active.record)}`,
    `Base URL: ${active.record.apiBaseUrl ?? "unknown"}`,
    `Models: ${String(active.record.models?.length ?? 0)}`,
    "Click for switch/import/export/API actions.",
  ];
  if (active.record.health?.checkedAt) {
    lines.push(`Last check: ${active.record.health.checkedAt}`);
  }
  if (active.record.healthError) {
    lines.push(`Health error: ${active.record.healthError}`);
  }
  if (state.restart.thisWindowNeedsReload) {
    lines.push(
      `Auth window reload still needed: ${state.restart.currentWindowAccountLabel ?? "current window account"}.`,
    );
  }
  return lines.join("\n");
}

function buildUnavailableTooltip(
  currentWindowAccount: CurrentWindowAccountState,
  state: ControllerState,
): string {
  const label = currentWindowAccount.label ?? "unknown account";
  const lines: string[] = [
    `Current window: ${label}`,
    "Usage: unavailable",
    "This window is running an account that is not currently available in managed snapshots.",
    "Click for switch/import/export/refresh actions.",
  ];
  if (state.restart.thisWindowNeedsReload) {
    lines.push(
      `Reload needed: current window account is ${state.restart.currentWindowAccountLabel ?? "the current window account"}.`,
    );
    lines.push(
      `Disk live auth.json is ${state.restart.liveAccountLabel ?? "a different login state"}${state.restart.switchedAt ? ` at ${state.restart.switchedAt}` : ""}.`,
    );
  }
  return lines.join("\n");
}
