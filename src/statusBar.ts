import * as vscode from "vscode";

import { getAccountLabel } from "./auth";
import type { ControllerState } from "./controller";
import { CodexAccountsController } from "./controller";
import type { ManagedAccount } from "./types";

type StatusMenuAction =
  | "openSidebar"
  | "switchAccount"
  | "refreshUsage"
  | "saveCurrent"
  | "startLogin"
  | "importBundle"
  | "exportBundle";

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
      this.item.text = "$(account) Codex: no account";
      this.item.tooltip = "No active managed account.";
      this.item.show();
      return;
    }

    const usage = summarizeUsage(active);
    this.item.text = `$(account) ${usage}`;
    this.item.tooltip = buildTooltip(active);
    this.item.show();
  }

  public async openMenu(): Promise<void> {
    const active = this.controller.getState().accounts.find((account) => account.isActive);

    const action = await vscode.window.showQuickPick(
      [
        {
          label: "$(sidebar-left) Open Accounts Sidebar",
          description: "Show the full Codex Accounts panel in Explorer.",
          action: "openSidebar" as StatusMenuAction,
        },
        {
          label: "$(arrow-swap) Switch Account",
          description: "Pick and switch active account snapshot.",
          action: "switchAccount" as StatusMenuAction,
        },
        {
          label: "$(history) Refresh Usage",
          description: active
            ? `Refresh usage for ${getAccountLabel(active.record)}`
            : "Refresh usage for all managed accounts",
          action: "refreshUsage" as StatusMenuAction,
        },
        {
          label: "$(archive) Save Current Account",
          description: "Capture the current ~/.codex/auth.json snapshot.",
          action: "saveCurrent" as StatusMenuAction,
        },
        {
          label: "$(plus) Start New Login",
          description: "Open terminal and run codex login.",
          action: "startLogin" as StatusMenuAction,
        },
        {
          label: "$(folder-opened) Import Bundle",
          description: "Import account snapshots from JSON.",
          action: "importBundle" as StatusMenuAction,
        },
        {
          label: "$(export) Export Bundle",
          description: "Export all managed account snapshots.",
          action: "exportBundle" as StatusMenuAction,
        },
      ],
      {
        placeHolder: "Codex Accounts",
        ignoreFocusOut: true,
      },
    );
    if (!action) {
      return;
    }

    switch (action.action) {
      case "openSidebar":
        await vscode.commands.executeCommand("codexAccounts.openSidebar");
        break;
      case "switchAccount":
        await vscode.commands.executeCommand("codexAccounts.switchAccount");
        break;
      case "refreshUsage":
        await vscode.commands.executeCommand("codexAccounts.refreshUsage");
        break;
      case "saveCurrent":
        await vscode.commands.executeCommand("codexAccounts.saveCurrentAccount");
        break;
      case "startLogin":
        await vscode.commands.executeCommand("codexAccounts.startLogin");
        break;
      case "importBundle":
        await vscode.commands.executeCommand("codexAccounts.importBundle");
        break;
      case "exportBundle":
        await vscode.commands.executeCommand("codexAccounts.exportBundle");
        break;
      default:
        break;
    }
  }

  private createStatusBarItem(): void {
    this.item?.dispose();
    this.item = vscode.window.createStatusBarItem(getAlignment(), 120);
    this.item.command = "codexAccounts.statusBarMenu";
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
    return "Codex usage --";
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
    return `${getAccountLabel(active.record)} · usage --`;
  }

  return `${getAccountLabel(active.record)} · ${parts.join(" | ")}`;
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
