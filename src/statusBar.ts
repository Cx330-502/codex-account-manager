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

    const currentWindowAccount = state.currentWindowAccount;
    if (!currentWindowAccount.account) {
      this.item.text = "$(pulse) 5h -- | 1w --";
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
  const usage = active.record.usage;
  if (!usage) {
    return "5h -- | 1w --";
  }

  const fiveHour = usage.windows.find((window) => window.key === "5h")?.remainingPercent;
  const weekly = usage.windows.find((window) => window.key === "1w")?.remainingPercent;
  const parts: string[] = [];
  if (fiveHour != null) {
    parts.push(`5h ${fiveHour}%`);
  }
  if (weekly != null) {
    parts.push(`1w ${weekly}%`);
  }
  if (parts.length === 0) {
    return "5h -- | 1w --";
  }

  return parts.join(" | ");
}

function buildTooltip(
  currentWindowAccount: CurrentWindowAccountState,
  state: ControllerState,
): string {
  const active = currentWindowAccount.account;
  if (!active) {
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
  const fiveHour = usage.windows.find((window) => window.key === "5h");
  const weekly = usage.windows.find((window) => window.key === "1w");
  if (fiveHour) {
    lines.push(`5h remaining: ${fiveHour.remainingPercent ?? "--"}%`);
  }
  if (weekly) {
    lines.push(`1w remaining: ${weekly.remainingPercent ?? "--"}%`);
  }
  if (active.record.usageError) {
    const failure = toUsageFailureInfo(active.record.usageError);
    lines.push(`Refresh error type: ${failure.typeLabel}`);
    lines.push(`Refresh error detail: ${failure.detail}`);
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
