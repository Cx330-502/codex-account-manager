#!/usr/bin/env node

import * as path from "node:path";

import blessed from "blessed";
import { Command } from "commander";

import { getAccountLabel, resolveCodexHome } from "./auth";
import {
  defaultCliConfig,
  normalizeCliConfig,
  readCliConfig,
  writeCliConfig,
  type CliRunMode,
} from "./cliConfig";
import { CodexAccountStore } from "./store";
import type { ManagedAccount, UsageWindowSummary } from "./types";
import { UsageService } from "./usage";
import { encodeUsageFailure, formatUsageFailureSummary } from "./usageFailure";

type StatusTone = "info" | "success" | "warning" | "danger";
type FocusPane = "menu" | "accounts";
type MenuActionId =
  | "refreshDashboard"
  | "refreshUsage"
  | "refreshToken"
  | "switchAccount"
  | "saveCurrentAuth"
  | "renameAccount"
  | "removeAccount"
  | "importBundle"
  | "exportBundle"
  | "settings"
  | "exit";
type AccountActionId =
  | "refreshUsage"
  | "refreshToken"
  | "switchAccount"
  | "renameAccount"
  | "removeAccount"
  | "back";

interface StatusMessage {
  tone: StatusTone;
  text: string;
}

interface RefreshSummary {
  refreshedCount: number;
  failedCount: number;
  firstFailure: string | null;
}

interface CliOptions {
  codexHome?: string;
  mode?: CliRunMode;
}

interface MenuItem {
  id: MenuActionId;
  label: string;
}

interface SelectOption<T extends string> {
  label: string;
  value: T;
}

const MENU_ITEMS: MenuItem[] = [
  { id: "refreshDashboard", label: "Reload data from disk" },
  { id: "refreshUsage", label: "Refresh usage" },
  { id: "refreshToken", label: "Refresh token" },
  { id: "switchAccount", label: "Switch account" },
  { id: "saveCurrentAuth", label: "Save current auth" },
  { id: "renameAccount", label: "Rename account" },
  { id: "removeAccount", label: "Remove account" },
  { id: "importBundle", label: "Import bundle" },
  { id: "exportBundle", label: "Export bundle" },
  { id: "settings", label: "Settings" },
  { id: "exit", label: "Exit" },
];

class CodexAccountsCliApp {
  private readonly store: CodexAccountStore;
  private readonly usageService = new UsageService();
  private readonly screen: blessed.Widgets.Screen;
  private readonly headerBox: blessed.Widgets.BoxElement;
  private readonly statusBox: blessed.Widgets.BoxElement;
  private readonly menuList: blessed.Widgets.ListElement;
  private readonly accountsTable: blessed.Widgets.ListTableElement;
  private readonly helpBox: blessed.Widgets.BoxElement;
  private readonly overlay: blessed.Widgets.BoxElement;

  private config = defaultCliConfig();
  private accounts: ManagedAccount[] = [];
  private statusMessage: StatusMessage = {
    tone: "info",
    text: "Ready.",
  };
  private lastAutoRefreshSummary = "No auto refresh has run yet.";
  private autoRefreshTimer: NodeJS.Timeout | undefined;
  private operationInFlight = false;
  private modalOpen = false;
  private focusPane: FocusPane = "menu";
  private shuttingDown = false;

  public constructor(
    private readonly codexHome: string,
    initialMode?: CliRunMode,
  ) {
    this.store = new CodexAccountStore(codexHome);
    if (initialMode) {
      this.config = normalizeCliConfig({
        ...this.config,
        runMode: initialMode,
      });
    }

    this.screen = blessed.screen({
      smartCSR: true,
      title: "Codex Accounts CLI",
      fullUnicode: true,
      dockBorders: true,
    });

    this.headerBox = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: 4,
      tags: true,
      border: "line",
      padding: {
        left: 1,
        right: 1,
      },
      style: {
        border: {
          fg: "cyan",
        },
      },
    });

    this.statusBox = blessed.box({
      parent: this.screen,
      top: 4,
      left: 0,
      width: "100%",
      height: 4,
      tags: true,
      border: "line",
      padding: {
        left: 1,
        right: 1,
      },
      style: {
        border: {
          fg: "blue",
        },
      },
    });

    this.menuList = blessed.list({
      parent: this.screen,
      top: 8,
      left: 0,
      width: "28%",
      bottom: 1,
      keys: true,
      vi: true,
      mouse: true,
      tags: true,
      border: "line",
      label: " Menu ",
      padding: {
        left: 1,
        right: 1,
      },
      style: {
        border: {
          fg: "blue",
        },
        selected: {
          bg: "cyan",
          fg: "black",
          bold: true,
        },
        item: {
          fg: "white",
        },
      },
      items: MENU_ITEMS.map((item) => item.label),
      scrollbar: {
        ch: " ",
      },
    });

    this.accountsTable = blessed.listtable({
      parent: this.screen,
      top: 8,
      left: "28%",
      width: "72%",
      bottom: 1,
      keys: true,
      vi: true,
      mouse: true,
      tags: false,
      border: "line",
      label: " Accounts ",
      align: "left",
      noCellBorders: false,
      pad: 1,
      style: {
        border: {
          fg: "blue",
        },
        header: {
          fg: "cyan",
          bold: true,
        },
        cell: {
          fg: "white",
          selected: {
            bg: "cyan",
            fg: "black",
          },
        },
      },
      data: [["#", "A", "Account", "5h", "1w", "Status"]],
      scrollbar: {
        ch: " ",
      },
    });

    this.helpBox = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: true,
      style: {
        fg: "black",
        bg: "white",
      },
    });

    this.overlay = blessed.box({
      parent: this.screen,
      hidden: true,
      width: "100%",
      height: "100%",
      style: {
        bg: "black",
        transparent: false,
      },
    });

    this.bindEvents();
  }

  public async run(): Promise<void> {
    await this.store.ensureReady();
    const diskConfig = await readCliConfig(this.store.managerRoot);
    this.config = normalizeCliConfig({
      ...diskConfig,
      runMode: this.config.runMode,
    });
    await writeCliConfig(this.store.managerRoot, this.config);
    await this.refreshAccounts();
    this.startAutoRefreshLoop();
    this.updateUi();
    this.menuList.focus();
    this.screen.render();

    await new Promise<void>((resolve) => {
      this.screen.once("destroy", () => resolve());
    });
  }

  private bindEvents(): void {
    this.screen.key(["C-c", "q"], () => {
      this.shutdown();
    });

    this.screen.key(["left"], () => {
      if (this.modalOpen) {
        return;
      }
      this.focusMenu();
    });

    this.screen.key(["right"], () => {
      if (this.modalOpen) {
        return;
      }
      this.focusAccounts();
    });

    this.screen.key(["tab"], () => {
      if (this.modalOpen) {
        return;
      }
      if (this.focusPane === "menu") {
        this.focusAccounts();
      } else {
        this.focusMenu();
      }
    });

    this.screen.key(["escape"], () => {
      if (this.modalOpen) {
        return;
      }
      if (this.focusPane === "accounts") {
        this.focusMenu();
      }
    });

    this.menuList.on("focus", () => {
      this.focusPane = "menu";
      this.updateHelp();
      this.screen.render();
    });

    this.accountsTable.on("focus", () => {
      this.focusPane = "accounts";
      this.updateHelp();
      this.screen.render();
    });

    this.menuList.key(["enter"], () => {
      if (this.modalOpen) {
        return;
      }
      const selected = MENU_ITEMS[getListSelectedIndex(this.menuList)];
      if (selected) {
        void this.executeMenuAction(selected.id);
      }
    });

    this.accountsTable.key(["enter"], () => {
      if (this.modalOpen) {
        return;
      }
      void this.openAccountActionMenu();
    });
  }

  private async executeMenuAction(actionId: MenuActionId): Promise<void> {
    await this.runExclusive(async () => {
      switch (actionId) {
        case "refreshDashboard":
          await this.refreshAccounts();
          this.setStatus("info", "Reloaded accounts and usage data from disk.");
          break;
        case "refreshUsage":
          await this.handleRefreshUsage("manual");
          break;
        case "refreshToken":
          await this.handleRefreshTokens();
          break;
        case "switchAccount":
          await this.handleSwitchAccount();
          break;
        case "saveCurrentAuth":
          await this.handleSaveCurrentAuth();
          break;
        case "renameAccount":
          await this.handleRenameAccount();
          break;
        case "removeAccount":
          await this.handleRemoveAccount();
          break;
        case "importBundle":
          await this.handleImportBundle();
          break;
        case "exportBundle":
          await this.handleExportBundle();
          break;
        case "settings":
          await this.handleSettings();
          break;
        case "exit":
          this.shutdown();
          break;
        default:
          break;
      }
    });
  }

  private async handleRefreshUsage(reason: "manual" | "auto"): Promise<void> {
    if (this.accounts.length === 0) {
      this.setStatus("warning", "No managed accounts found.");
      return;
    }

    const targets =
      reason === "auto"
        ? this.accounts
        : await this.pickRefreshTargets("Refresh usage", true);
    if (targets.length === 0) {
      if (reason === "manual") {
        this.setStatus("info", "Usage refresh canceled.");
      }
      return;
    }

    await this.refreshUsageForTargets(targets, reason);
  }

  private async refreshUsageForTargets(
    targets: ManagedAccount[],
    reason: "manual" | "auto",
  ): Promise<void> {
    if (targets.length === 0) {
      return;
    }

    const summary: RefreshSummary = {
      refreshedCount: 0,
      failedCount: 0,
      firstFailure: null,
    };

    for (const account of targets) {
      try {
        const result = await this.usageService.fetchUsage(account.auth, {
          allowTokenRefresh: false,
        });
        await this.store.setUsage(account.record.id, result.usage, null);
        summary.refreshedCount += 1;
      } catch (error) {
        const message = toErrorMessage(error);
        await this.store.setUsage(
          account.record.id,
          undefined,
          encodeUsageFailure(message),
        );
        summary.failedCount += 1;
        summary.firstFailure ??= message;
      }
    }

    await this.refreshAccounts();

    if (reason === "auto") {
      this.lastAutoRefreshSummary = formatRefreshSummary(summary);
      if (summary.failedCount > 0 && summary.firstFailure) {
        this.setStatus(
          "warning",
          `Auto refresh: ${formatShortFailure(summary.firstFailure)}. Refresh token manually if needed.`,
        );
      } else {
        this.setStatus("success", `Auto refresh complete. ${formatRefreshSummary(summary)}`);
      }
      return;
    }

    if (summary.failedCount > 0 && summary.firstFailure) {
      this.setStatus(
        "warning",
        `Usage refresh finished. ${formatRefreshSummary(summary)}. ${formatShortFailure(summary.firstFailure)}`,
      );
      return;
    }

    this.setStatus("success", `Usage refresh finished. ${formatRefreshSummary(summary)}`);
  }

  private async handleRefreshTokens(): Promise<void> {
    if (this.accounts.length === 0) {
      this.setStatus("warning", "No managed accounts found.");
      return;
    }

    const targets = await this.pickRefreshTargets("Refresh token", true);
    if (targets.length === 0) {
      this.setStatus("info", "Token refresh canceled.");
      return;
    }

    await this.refreshTokensForTargets(targets);
  }

  private async refreshTokensForTargets(targets: ManagedAccount[]): Promise<void> {
    if (targets.length === 0) {
      return;
    }

    let refreshedCount = 0;
    let failedCount = 0;
    let firstFailure: string | null = null;

    for (const target of targets) {
      try {
        const refreshedAuth = await this.usageService.refreshTokens(target.auth);
        await this.store.updateAccountAuth(target.record.id, refreshedAuth);
        const usageResult = await this.usageService.fetchUsage(refreshedAuth, {
          allowTokenRefresh: false,
        });
        await this.store.setUsage(target.record.id, usageResult.usage, null);
        refreshedCount += 1;
      } catch (error) {
        const message = toErrorMessage(error);
        await this.store.setUsage(
          target.record.id,
          undefined,
          encodeUsageFailure(message),
        );
        failedCount += 1;
        firstFailure ??= message;
      }
    }

    await this.refreshAccounts();

    if (failedCount > 0 && firstFailure) {
      this.setStatus(
        "warning",
        `Token refresh finished. refreshed ${refreshedCount}, failed ${failedCount}. ${formatShortFailure(firstFailure)}`,
      );
      return;
    }

    this.setStatus("success", `Token refresh finished. refreshed ${refreshedCount}.`);
  }

  private async handleSwitchAccount(): Promise<void> {
    if (this.accounts.length === 0) {
      this.setStatus("warning", "No managed accounts found.");
      return;
    }

    const account = await this.pickAccount("Switch account");
    if (!account) {
      this.setStatus("info", "Switch canceled.");
      return;
    }

    await this.store.switchToAccount(account.record.id);
    await this.refreshAccounts();
    this.selectAccountById(account.record.id);
    this.setStatus("success", `Switched live auth to ${getAccountLabel(account.record)}.`);
  }

  private async handleSaveCurrentAuth(): Promise<void> {
    const record = await this.store.captureCurrentAuth("manual");
    if (!record) {
      this.setStatus("warning", `No auth.json found at ${this.store.authPath}.`);
      return;
    }

    await this.refreshAccounts();
    this.selectAccountById(record.id);
    this.setStatus("success", `Saved current account: ${getAccountLabel(record)}.`);
  }

  private async handleRenameAccount(target?: ManagedAccount): Promise<void> {
    const account = target ?? (await this.pickAccount("Rename account"));
    if (!account) {
      this.setStatus("info", "Rename canceled.");
      return;
    }

    const label = await this.promptInput(
      "Rename account",
      "New label (leave empty to clear)",
      account.record.label ?? "",
    );
    if (label === null) {
      this.setStatus("info", "Rename canceled.");
      return;
    }

    await this.store.renameAccount(account.record.id, label.trim() || undefined);
    await this.refreshAccounts();
    this.selectAccountById(account.record.id);
    this.setStatus("success", `Updated label for ${getAccountLabel(account.record)}.`);
  }

  private async handleRemoveAccount(target?: ManagedAccount): Promise<void> {
    const account = target ?? (await this.pickAccount("Remove account"));
    if (!account) {
      this.setStatus("info", "Remove canceled.");
      return;
    }

    const confirmed = await this.confirm(
      "Remove account",
      `Remove managed snapshot for ${getAccountLabel(account.record)}?`,
    );
    if (!confirmed) {
      this.setStatus("info", "Remove canceled.");
      return;
    }

    await this.store.removeAccount(account.record.id);
    await this.refreshAccounts();
    this.setStatus("success", `Removed ${getAccountLabel(account.record)}.`);
  }

  private async handleImportBundle(): Promise<void> {
    const sourcePath = await this.promptInput(
      "Import bundle",
      "Bundle path to import",
      "",
    );
    if (!sourcePath) {
      this.setStatus("info", "Import canceled.");
      return;
    }

    const importedCount = await this.store.importBundle(path.resolve(sourcePath));
    await this.refreshAccounts();
    this.setStatus("success", `Imported ${importedCount} account snapshot(s).`);
  }

  private async handleExportBundle(): Promise<void> {
    const defaultPath = path.resolve(
      `codex-accounts-export-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );
    const targetPath = await this.promptInput(
      "Export bundle",
      "Export path",
      defaultPath,
    );
    if (!targetPath) {
      this.setStatus("info", "Export canceled.");
      return;
    }

    const exportedCount = await this.store.exportBundle(path.resolve(targetPath));
    this.setStatus("success", `Exported ${exportedCount} account snapshot(s) to ${targetPath}.`);
  }

  private async handleSettings(): Promise<void> {
    const action = await this.pickOption(
      "Settings",
      [
        { label: `Run mode: ${this.config.runMode}`, value: "mode" },
        {
          label: `Auto usage interval: ${this.config.usageAutoRefreshIntervalMinutes} min`,
          value: "interval",
        },
        { label: "Back", value: "back" },
      ],
      0,
    );

    if (!action || action === "back") {
      this.setStatus("info", "Settings unchanged.");
      return;
    }

    if (action === "mode") {
      const mode = await this.pickOption<CliRunMode>(
        "Run mode",
        [
          { label: "manual-only", value: "manual-only" },
          { label: "usage-auto", value: "usage-auto" },
        ],
        this.config.runMode === "usage-auto" ? 1 : 0,
      );
      if (!mode) {
        this.setStatus("info", "Settings unchanged.");
        return;
      }

      this.config = normalizeCliConfig({
        ...this.config,
        runMode: mode,
      });
      await writeCliConfig(this.store.managerRoot, this.config);
      this.restartAutoRefreshLoop();
      this.setStatus("success", `Run mode updated to ${mode}.`);
      return;
    }

    const intervalText = await this.promptInput(
      "Auto usage interval",
      "Minutes between automatic usage refreshes",
      String(this.config.usageAutoRefreshIntervalMinutes),
    );
    if (!intervalText) {
      this.setStatus("info", "Settings unchanged.");
      return;
    }

    const parsed = Number.parseInt(intervalText, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      this.setStatus("warning", "Interval must be an integer greater than or equal to 1.");
      return;
    }

    this.config = normalizeCliConfig({
      ...this.config,
      usageAutoRefreshIntervalMinutes: parsed,
    });
    await writeCliConfig(this.store.managerRoot, this.config);
    this.restartAutoRefreshLoop();
    this.setStatus(
      "success",
      `Auto usage refresh interval updated to ${this.config.usageAutoRefreshIntervalMinutes} minute(s).`,
    );
  }

  private async openAccountActionMenu(): Promise<void> {
    if (this.accounts.length === 0) {
      this.setStatus("warning", "No managed accounts found.");
      return;
    }

    const account = this.getSelectedAccount();
    if (!account) {
      this.setStatus("warning", "Select an account first.");
      return;
    }

    const action = await this.pickOption<AccountActionId>(
      `Account: ${getAccountLabel(account.record)}`,
      [
        { label: "Refresh usage", value: "refreshUsage" },
        { label: "Refresh token", value: "refreshToken" },
        { label: "Switch account", value: "switchAccount" },
        { label: "Rename account", value: "renameAccount" },
        { label: "Remove account", value: "removeAccount" },
        { label: "Back", value: "back" },
      ],
      0,
    );

    if (!action || action === "back") {
      return;
    }

    await this.runExclusive(async () => {
      switch (action) {
        case "refreshUsage":
          await this.handleRefreshUsageForAccounts([account], "manual");
          break;
        case "refreshToken":
          await this.handleRefreshTokensForAccounts([account]);
          break;
        case "switchAccount":
          await this.store.switchToAccount(account.record.id);
          await this.refreshAccounts();
          this.selectAccountById(account.record.id);
          this.setStatus("success", `Switched live auth to ${getAccountLabel(account.record)}.`);
          break;
        case "renameAccount":
          await this.handleRenameAccount(account);
          break;
        case "removeAccount":
          await this.handleRemoveAccount(account);
          break;
        default:
          break;
      }
    });
  }

  private async handleRefreshUsageForAccounts(
    targets: ManagedAccount[],
    reason: "manual" | "auto",
  ): Promise<void> {
    await this.refreshUsageForTargets(targets, reason);
  }

  private async handleRefreshTokensForAccounts(
    targets: ManagedAccount[],
  ): Promise<void> {
    await this.refreshTokensForTargets(targets);
  }

  private async pickRefreshTargets(
    title: string,
    allowAll: boolean,
  ): Promise<ManagedAccount[]> {
    const active = this.accounts.find((account) => account.isActive) ?? null;
    const options: SelectOption<"active" | "specific" | "all">[] = [];
    if (active) {
      options.push({
        label: `Current active account (${getAccountLabel(active.record)})`,
        value: "active",
      });
    }
    options.push({
      label: "Choose a specific account",
      value: "specific",
    });
    if (allowAll) {
      options.push({
        label: "All accounts",
        value: "all",
      });
    }

    const selected = await this.pickOption(title, options, 0);
    if (!selected) {
      return [];
    }
    if (selected === "active" && active) {
      return [active];
    }
    if (selected === "specific") {
      const account = await this.pickAccount(title);
      return account ? [account] : [];
    }
    return allowAll ? this.accounts : [];
  }

  private async pickAccount(title: string): Promise<ManagedAccount | null> {
    if (this.accounts.length === 0) {
      return null;
    }

    const options = this.accounts.map((account) => ({
      label: `${account.isActive ? "* " : ""}${getAccountLabel(account.record)}`,
      value: account.record.id,
    }));
    const defaultIndex = Math.max(getListSelectedIndex(this.accountsTable) - 1, 0);
    const selectedId = await this.pickOption(title, options, defaultIndex);
    if (!selectedId) {
      return null;
    }
    return this.accounts.find((account) => account.record.id === selectedId) ?? null;
  }

  private async refreshAccounts(): Promise<void> {
    const previouslySelectedId = this.getSelectedAccount()?.record.id ?? null;
    this.accounts = await this.store.listAccounts();
    this.renderAccountsTable();
    if (previouslySelectedId) {
      this.selectAccountById(previouslySelectedId);
    } else if (this.accounts.length > 0) {
      this.accountsTable.select(1);
    }
    this.updateUi();
  }

  private renderAccountsTable(): void {
    const narrow = (this.screen.width as number) < 120;
    const header = narrow
      ? ["#", "Live", "Account", "5h", "1w", "Status"]
      : ["#", "Live", "Account", "Plan", "5h", "1w", "5h reset", "1w reset", "Status"];
    const rows = [header];

    if (this.accounts.length === 0) {
      rows.push(
        narrow
          ? ["-", "-", "No accounts", "-", "-", "-"]
          : ["-", "-", "No accounts", "-", "-", "-", "-", "-", "-"],
      );
    } else {
      for (const [index, account] of this.accounts.entries()) {
        const fiveHour = findWindow(account, "5h");
        const weekly = findWindow(account, "1w");
        const status = truncate(buildUsageStatus(account), narrow ? 18 : 34);
        const accountLabel = account.isActive
          ? `CURRENT ${getAccountLabel(account.record)}`
          : getAccountLabel(account.record);
        const liveMarker = account.isActive ? "LIVE" : "";

        if (narrow) {
          rows.push([
            String(index + 1),
            liveMarker,
            truncate(accountLabel, 22),
            formatRemaining(fiveHour),
            formatRemaining(weekly),
            status,
          ]);
        } else {
          rows.push([
            String(index + 1),
            liveMarker,
            truncate(accountLabel, 28),
            truncate(account.record.usage?.planType ?? account.record.usage?.creditLabel ?? "--", 10),
            formatRemaining(fiveHour),
            formatRemaining(weekly),
            formatReset(fiveHour),
            formatReset(weekly),
            status,
          ]);
        }
      }
    }

    this.accountsTable.setData(rows);
  }

  private updateUi(): void {
    const proxyState = getProxyStateSummary();
    const focusLabel =
      this.focusPane === "menu" ? "LEFT MENU" : "RIGHT ACCOUNTS";
    this.headerBox.setContent(
      [
        `{bold}Codex Accounts CLI{/bold}`,
        `Mode: ${this.config.runMode}`,
        `Auto usage interval: ${this.config.usageAutoRefreshIntervalMinutes} min`,
        `Focus: ${focusLabel}`,
        `Accounts: ${this.accounts.length}`,
      ].join(" | ") +
        "\n" +
        [
          `CODEX_HOME: ${truncate(this.codexHome, 46)}`,
          `HTTP proxy: ${proxyState.http}`,
          `HTTPS proxy: ${proxyState.https}`,
        ].join(" | "),
    );

    this.statusBox.setContent(
      `${formatToneLabel(this.statusMessage)} ${this.statusMessage.text}\nFocus now: ${focusLabel} | Auto refresh: ${this.lastAutoRefreshSummary}`,
    );

    this.menuList.style.border.fg = this.focusPane === "menu" ? "yellow" : "blue";
    this.accountsTable.style.border.fg =
      this.focusPane === "accounts" ? "yellow" : "blue";
    this.menuList.style.selected =
      this.focusPane === "menu"
        ? {
            bg: "cyan",
            fg: "black",
            bold: true,
          }
        : {
            bg: undefined,
            fg: "white",
            bold: false,
          };
    this.accountsTable.style.cell = {
      ...(this.accountsTable.style.cell ?? {}),
      fg: "white",
      selected:
        this.focusPane === "accounts"
          ? {
              bg: "cyan",
              fg: "black",
              bold: true,
            }
          : {
              bg: undefined,
              fg: "white",
              bold: false,
            },
    };
    this.updateHelp();
    this.screen.render();
  }

  private updateHelp(): void {
    const rightPaneHint =
      this.focusPane === "accounts"
        ? "Focus: RIGHT ACCOUNTS | Up/Down move | Enter account actions | Left menu | Tab menu | Esc menu | q quit"
        : "Focus: LEFT MENU | Up/Down move | Enter select | Right accounts | Tab accounts | q quit";
    this.helpBox.setContent(` ${rightPaneHint}`);
  }

  private focusMenu(): void {
    this.focusPane = "menu";
    this.menuList.focus();
    this.updateUi();
  }

  private focusAccounts(): void {
    this.focusPane = "accounts";
    this.accountsTable.focus();
    this.updateUi();
  }

  private getSelectedAccount(): ManagedAccount | null {
    const selected = getListSelectedIndex(this.accountsTable) - 1;
    if (selected < 0) {
      return null;
    }
    return this.accounts[selected] ?? null;
  }

  private selectAccountById(id: string): void {
    const index = this.accounts.findIndex((account) => account.record.id === id);
    if (index >= 0) {
      this.accountsTable.select(index + 1);
    }
  }

  private startAutoRefreshLoop(): void {
    if (this.config.runMode !== "usage-auto") {
      return;
    }

    this.autoRefreshTimer = setInterval(() => {
      void this.runAutoRefreshTick();
    }, this.config.usageAutoRefreshIntervalMinutes * 60_000);
  }

  private restartAutoRefreshLoop(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = undefined;
    }
    this.startAutoRefreshLoop();
    this.updateUi();
  }

  private async runAutoRefreshTick(): Promise<void> {
    if (this.operationInFlight || this.modalOpen || this.config.runMode !== "usage-auto") {
      return;
    }

    await this.runExclusive(async () => {
      await this.refreshAccounts();
      await this.handleRefreshUsage("auto");
    });
  }

  private async runExclusive(task: () => Promise<void>): Promise<void> {
    if (this.operationInFlight) {
      this.setStatus("warning", "Another operation is already running.");
      this.updateUi();
      return;
    }

    this.operationInFlight = true;
    try {
      await task();
    } catch (error) {
      this.setStatus("danger", toErrorMessage(error));
    } finally {
      this.operationInFlight = false;
      this.updateUi();
    }
  }

  private setStatus(tone: StatusTone, text: string): void {
    this.statusMessage = { tone, text };
  }

  private async pickOption<T extends string>(
    title: string,
    options: SelectOption<T>[],
    initialIndex: number,
  ): Promise<T | null> {
    if (options.length === 0) {
      return null;
    }

    this.modalOpen = true;
    const previousFocus = this.focusPane;

    return new Promise<T | null>((resolve) => {
      const container = blessed.box({
        parent: this.overlay,
        top: "center",
        left: "center",
        width: "60%",
        height: Math.min(options.length + 4, 18),
        border: "line",
        label: ` ${title} `,
        style: {
          border: {
            fg: "cyan",
          },
          bg: "black",
        },
      });

      const list = blessed.list({
        parent: container,
        top: 1,
        left: 1,
        width: "100%-2",
        height: "100%-2",
        keys: true,
        vi: true,
        mouse: true,
        items: options.map((option) => option.label),
        style: {
          selected: {
            bg: "cyan",
            fg: "black",
            bold: true,
          },
        },
        scrollbar: {
          ch: " ",
        },
      });

      const cleanup = (value: T | null): void => {
        container.destroy();
        this.overlay.hide();
        this.modalOpen = false;
        if (previousFocus === "accounts") {
          this.focusAccounts();
        } else {
          this.focusMenu();
        }
        resolve(value);
      };

      list.select(Math.max(0, Math.min(initialIndex, options.length - 1)));
      list.key(["enter"], () => {
        const option = options[getListSelectedIndex(list)];
        cleanup(option?.value ?? null);
      });
      list.key(["escape", "q"], () => cleanup(null));
      this.overlay.show();
      list.focus();
      this.screen.render();
    });
  }

  private async promptInput(
    title: string,
    label: string,
    initialValue: string,
  ): Promise<string | null> {
    this.modalOpen = true;
    const previousFocus = this.focusPane;

    return new Promise<string | null>((resolve) => {
      const form = blessed.form({
        parent: this.overlay,
        top: "center",
        left: "center",
        width: "70%",
        height: 9,
        border: "line",
        label: ` ${title} `,
        keys: true,
        style: {
          border: {
            fg: "cyan",
          },
          bg: "black",
        },
      });

      blessed.text({
        parent: form,
        top: 1,
        left: 1,
        right: 1,
        height: 1,
        content: label,
      });

      const textbox = blessed.textbox({
        parent: form,
        top: 3,
        left: 1,
        right: 1,
        height: 3,
        inputOnFocus: true,
        border: "line",
        value: initialValue,
        style: {
          border: {
            fg: "blue",
          },
          focus: {
            border: {
              fg: "cyan",
            },
          },
        },
      });

      const cleanup = (value: string | null): void => {
        form.destroy();
        this.overlay.hide();
        this.modalOpen = false;
        if (previousFocus === "accounts") {
          this.focusAccounts();
        } else {
          this.focusMenu();
        }
        resolve(value);
      };

      textbox.key(["enter"], () => {
        cleanup(textbox.getValue());
      });
      textbox.key(["escape"], () => cleanup(null));
      this.overlay.show();
      textbox.focus();
      this.screen.render();
      textbox.readInput();
    });
  }

  private async confirm(title: string, question: string): Promise<boolean> {
    this.modalOpen = true;
    const previousFocus = this.focusPane;

    return new Promise<boolean>((resolve) => {
      const dialog = blessed.question({
        parent: this.overlay,
        top: "center",
        left: "center",
        width: "60%",
        height: 7,
        tags: true,
        border: "line",
        label: ` ${title} `,
        style: {
          border: {
            fg: "cyan",
          },
          bg: "black",
        },
      });

      const cleanup = (value: boolean): void => {
        dialog.destroy();
        this.overlay.hide();
        this.modalOpen = false;
        if (previousFocus === "accounts") {
          this.focusAccounts();
        } else {
          this.focusMenu();
        }
        resolve(value);
      };

      this.overlay.show();
      dialog.ask(question, (answer: boolean) => {
        cleanup(answer);
      });
      this.screen.render();
    });
  }

  private shutdown(): void {
    if (this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = undefined;
    }
    this.screen.destroy();
  }
}

function findWindow(
  account: ManagedAccount,
  key: UsageWindowSummary["key"],
): UsageWindowSummary | undefined {
  return account.record.usage?.windows.find((window) => window.key === key);
}

function formatRemaining(window: UsageWindowSummary | undefined): string {
  if (typeof window?.remainingPercent === "number") {
    return `${window.remainingPercent}%`;
  }
  return "--";
}

function formatReset(window: UsageWindowSummary | undefined): string {
  return window?.resetsAt ? formatTimestamp(window.resetsAt) : "--";
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildUsageStatus(account: ManagedAccount): string {
  if (account.record.usageError) {
    return formatShortFailure(account.record.usageError);
  }

  if (account.record.usage?.fetchedAt) {
    return `OK ${formatTimestamp(account.record.usage.fetchedAt)}`;
  }

  return "Usage unavailable";
}

function formatRefreshSummary(summary: RefreshSummary): string {
  const parts = [`refreshed ${summary.refreshedCount}`];
  if (summary.failedCount > 0) {
    parts.push(`failed ${summary.failedCount}`);
  }
  return parts.join(", ");
}

function formatShortFailure(raw: string): string {
  return truncate(formatUsageFailureSummary(raw), 80);
}

function getProxyStateSummary(): { http: string; https: string } {
  return {
    http: formatProxyValue(process.env.HTTP_PROXY ?? process.env.http_proxy),
    https: formatProxyValue(process.env.HTTPS_PROXY ?? process.env.https_proxy),
  };
}

function formatProxyValue(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "off";
  }

  try {
    const parsed = new URL(trimmed);
    return truncate(`${parsed.protocol}//${parsed.host}`, 28);
  } catch {
    return truncate(trimmed, 28);
  }
}

function getListSelectedIndex(
  list: blessed.Widgets.ListElement | blessed.Widgets.ListTableElement,
): number {
  return (list as unknown as { selected?: number }).selected ?? 0;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= 1) {
    return value.slice(0, maxLength);
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

function formatToneLabel(status: StatusMessage): string {
  switch (status.tone) {
    case "success":
      return "{green-fg}[OK]{/green-fg}";
    case "warning":
      return "{yellow-fg}[WARN]{/yellow-fg}";
    case "danger":
      return "{red-fg}[ERR]{/red-fg}";
    default:
      return "{cyan-fg}[INFO]{/cyan-fg}";
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(options: CliOptions): Promise<void> {
  const codexHome = resolveCodexHome(options.codexHome ?? "");
  const app = new CodexAccountsCliApp(codexHome, options.mode);
  await app.run();
}

const program = new Command();
program
  .name("codex-accounts")
  .description("Interactive full-screen TUI for Codex account snapshots, usage, and token refresh.")
  .option("--codex-home <path>", "override CODEX_HOME or ~/.codex")
  .option("--mode <mode>", "start in manual-only or usage-auto mode")
  .action(async (options: CliOptions) => {
    const mode =
      options.mode === "manual-only" || options.mode === "usage-auto"
        ? options.mode
        : undefined;
    await main({
      codexHome: options.codexHome,
      mode,
    });
  });

void program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(toErrorMessage(error));
  process.exitCode = 1;
});
