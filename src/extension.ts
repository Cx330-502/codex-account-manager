import * as vscode from "vscode";

import { resolveCodexHome } from "./auth";
import { CodexAccountsController } from "./controller";
import { CodexAccountsSidebarProvider } from "./sidebar";
import { CodexAccountsStatusBarController } from "./statusBar";
import { CodexAccountStore } from "./store";
import { UsageService } from "./usage";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const codexHome = resolveCodexHome(
    vscode.workspace
      .getConfiguration("codexAccounts")
      .get<string>("codexHome", ""),
  );

  const controller = new CodexAccountsController(
    new CodexAccountStore(codexHome),
    new UsageService(),
  );
  context.subscriptions.push(controller);

  const sidebarProvider = new CodexAccountsSidebarProvider(
    context.extensionUri,
    controller,
  );
  context.subscriptions.push(sidebarProvider);
  const statusBar = new CodexAccountsStatusBarController(controller);
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "codexAccountsView",
      sidebarProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexAccounts.refresh", async () => {
      await controller.refresh();
    }),
    vscode.commands.registerCommand(
      "codexAccounts.saveCurrentAccount",
      async () => {
        await controller.saveCurrentAccount();
      },
    ),
    vscode.commands.registerCommand(
      "codexAccounts.switchAccount",
      async (item) => {
        await controller.switchAccount(item);
      },
    ),
    vscode.commands.registerCommand(
      "codexAccounts.removeAccount",
      async (item) => {
        await controller.removeAccount(item);
      },
    ),
    vscode.commands.registerCommand(
      "codexAccounts.renameAccount",
      async (item) => {
        await controller.renameAccount(item);
      },
    ),
    vscode.commands.registerCommand(
      "codexAccounts.importBundle",
      async () => {
        await controller.importBundle();
      },
    ),
    vscode.commands.registerCommand(
      "codexAccounts.exportBundle",
      async () => {
        await controller.exportBundle();
      },
    ),
    vscode.commands.registerCommand("codexAccounts.startLogin", async () => {
      await controller.startLogin();
    }),
    vscode.commands.registerCommand("codexAccounts.openCodexHome", async () => {
      await controller.openCodexHome();
    }),
    vscode.commands.registerCommand(
      "codexAccounts.refreshUsage",
      async (item) => {
        await controller.refreshUsage(item);
      },
    ),
    vscode.commands.registerCommand("codexAccounts.statusBarMenu", async () => {
      await statusBar.openMenu();
    }),
    vscode.commands.registerCommand("codexAccounts.openSidebar", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.codexAccounts");
      await vscode.commands.executeCommand("codexAccountsView.focus");
    }),
  );

  await controller.initialize();
  statusBar.render(controller.getState());
}

export function deactivate(): void {
  // No-op; controller disposal is wired through extension subscriptions.
}
