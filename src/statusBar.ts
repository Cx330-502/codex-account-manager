import * as vscode from "vscode";

import { getAccountLabel } from "./auth";
import type { ControllerState } from "./controller";
import { CodexAccountsController } from "./controller";
import type { ManagedAccount } from "./types";

export class CodexAccountsStatusBarController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private item: vscode.StatusBarItem | undefined;
  private restartItem: vscode.StatusBarItem | undefined;

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
  }

  public render(state: ControllerState): void {
    if (!this.item) {
      return;
    }

    const active = state.accounts.find((account) => account.isActive);
    if (!active) {
      this.item.text = "$(pulse) 5h -- | 1w --";
      this.item.tooltip = "No active managed account. Click to open quick actions.";
      this.item.show();
      this.renderRestartState(state);
      return;
    }

    const usage = summarizeUsage(active);
    this.item.text = `$(pulse) ${usage}`;
    this.item.tooltip = `${buildTooltip(active, state)}\nClick to open the full sidebar.`;
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
  }

  private renderRestartState(state: ControllerState): void {
    if (!this.restartItem) {
      return;
    }

    if (!state.restart.thisWindowNeedsReload) {
      this.restartItem.hide();
      return;
    }

    const currentLabel = state.restart.currentWindowAccountLabel ?? "previous account";
    const liveLabel = state.restart.liveAccountLabel ?? "new account";
    this.restartItem.text = `$(warning) Reload: ${currentLabel} -> ${liveLabel}`;
    this.restartItem.tooltip =
      `This window still uses ${currentLabel} until reload.\n` +
      `Live auth.json now points to ${liveLabel}.\n` +
      `Pending windows: ${state.restart.pendingWindowCount}\n` +
      "Click to reload this VS Code window.";
    this.restartItem.show();
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

function buildTooltip(active: ManagedAccount, state: ControllerState): string {
  const lines: string[] = [
    `Active: ${getAccountLabel(active.record)}`,
    "Click for switch/import/export/refresh actions.",
  ];
  if (state.restart.thisWindowNeedsReload) {
    lines.push(
      `Reload needed: this window is still on ${state.restart.currentWindowAccountLabel ?? "the previous account"}.`,
    );
    lines.push(
      `Live auth switched to ${state.restart.liveAccountLabel ?? "the new account"}${state.restart.switchedAt ? ` at ${state.restart.switchedAt}` : ""}.`,
    );
  }
  const usage = active.record.usage;
  if (!usage) {
    lines.push("Usage: unavailable");
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
  return lines.join("\n");
}
