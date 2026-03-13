import * as vscode from "vscode";

import { getAccountLabel } from "./auth";
import type { ControllerState } from "./controller";
import { CodexAccountsController } from "./controller";
import type { ManagedAccount } from "./types";

export class CodexAccountsStatusBarController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private item: vscode.StatusBarItem | undefined;

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
      return;
    }

    const usage = summarizeUsage(active);
    this.item.text = `$(pulse) ${usage}`;
    this.item.tooltip = `${buildTooltip(active)}\nClick to open the full sidebar.`;
    this.item.show();
  }

  private createStatusBarItem(): void {
    this.item?.dispose();
    this.item = vscode.window.createStatusBarItem(getAlignment(), 120);
    this.item.command = "codexAccounts.openSidebar";
    this.item.name = "Codex Accounts";
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

function buildTooltip(active: ManagedAccount): string {
  const lines: string[] = [
    `Active: ${getAccountLabel(active.record)}`,
    "Click for switch/import/export/refresh actions.",
  ];
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
