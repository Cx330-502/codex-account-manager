import { randomBytes } from "node:crypto";

import * as vscode from "vscode";

import { getAccountLabel } from "./auth";
import type { ControllerState } from "./controller";
import { CodexAccountsController } from "./controller";

type SidebarMessage =
  | { type: "refresh" }
  | { type: "saveCurrentAccount" }
  | { type: "importBundle" }
  | { type: "exportBundle" }
  | { type: "reloadWindow" }
  | { type: "startLogin" }
  | { type: "openCodexHome" }
  | { type: "switchAccount"; id: string }
  | { type: "renameAccount"; id: string }
  | { type: "removeAccount"; id: string }
  | { type: "refreshUsage"; id?: string };

export class CodexAccountsSidebarProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private readonly disposables: vscode.Disposable[] = [];
  private view: vscode.WebviewView | undefined;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: CodexAccountsController,
  ) {
    this.disposables.push(
      this.controller.onDidChangeState(() => {
        void this.postState();
      }),
    );
  }

  public dispose(): void {
    this.disposables.forEach((disposable) => disposable.dispose());
    this.disposables.length = 0;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
  ): void | Thenable<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    this.disposables.push(
      webviewView.webview.onDidReceiveMessage(async (message: SidebarMessage) => {
        await this.handleMessage(message);
      }),
    );

    void this.postState();
  }

  private async handleMessage(message: SidebarMessage): Promise<void> {
    switch (message.type) {
      case "refresh":
        await vscode.commands.executeCommand("codexAccounts.refresh");
        break;
      case "saveCurrentAccount":
        await vscode.commands.executeCommand("codexAccounts.saveCurrentAccount");
        break;
      case "importBundle":
        await vscode.commands.executeCommand("codexAccounts.importBundle");
        break;
      case "exportBundle":
        await vscode.commands.executeCommand("codexAccounts.exportBundle");
        break;
      case "reloadWindow":
        await vscode.commands.executeCommand("codexAccounts.reloadWindow");
        break;
      case "startLogin":
        await vscode.commands.executeCommand("codexAccounts.startLogin");
        break;
      case "openCodexHome":
        await vscode.commands.executeCommand("codexAccounts.openCodexHome");
        break;
      case "switchAccount":
        await vscode.commands.executeCommand("codexAccounts.switchAccount", message.id);
        break;
      case "renameAccount":
        await vscode.commands.executeCommand("codexAccounts.renameAccount", message.id);
        break;
      case "removeAccount":
        await vscode.commands.executeCommand("codexAccounts.removeAccount", message.id);
        break;
      case "refreshUsage":
        await vscode.commands.executeCommand(
          "codexAccounts.refreshUsage",
          message.id,
        );
        break;
      default:
        break;
    }
  }

  private async postState(): Promise<void> {
    if (!this.view) {
      return;
    }

    await this.view.webview.postMessage({
      type: "state",
      payload: this.toViewState(this.controller.getState()),
    });
  }

  private toViewState(state: ControllerState): unknown {
    return {
      generatedAt: new Date().toISOString(),
      lastError: state.lastError,
      sharedHint:
        "Switches auth only. sessions / memories / state_5.sqlite stay shared.",
      sharedPaths: state.sharedState,
      restart: state.restart,
      accounts: state.accounts.map((account) => ({
        id: account.record.id,
        label: getAccountLabel(account.record),
        email: account.record.email ?? null,
        authMode: account.record.authMode ?? null,
        accountId: account.record.chatgptAccountId ?? account.record.accountId ?? null,
        isActive: account.isActive,
        planType: account.record.usage?.planType ?? null,
        creditLabel: account.record.usage?.creditLabel ?? null,
        usageFetchedAt: account.record.usage?.fetchedAt ?? null,
        usageSourceTimestamp: account.record.usage?.sourceTimestamp ?? null,
        usageCheckedAt:
          account.record.usageCheckedAt ??
          account.record.usage?.fetchedAt ??
          null,
        usageError: account.record.usageError ?? null,
        lastCapturedAt: account.record.lastCapturedAt,
        lastUsedAt: account.record.lastUsedAt ?? null,
        windows: account.record.usage?.windows ?? [],
      })),
    };
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = createNonce();

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      :root {
        color-scheme: light dark;
        --bg: var(--vscode-sideBar-background);
        --panel: color-mix(in srgb, var(--vscode-sideBar-background) 78%, var(--vscode-editor-background));
        --panel-strong: color-mix(in srgb, var(--vscode-sideBar-background) 60%, var(--vscode-editor-background));
        --panel-border: color-mix(in srgb, var(--vscode-panel-border) 65%, transparent);
        --muted: var(--vscode-descriptionForeground);
        --fg: var(--vscode-foreground);
        --accent: var(--vscode-button-background);
        --accent-fg: var(--vscode-button-foreground);
        --accent-soft: color-mix(in srgb, var(--vscode-button-background) 18%, transparent);
        --accent-strong: color-mix(in srgb, var(--vscode-button-background) 72%, white);
        --success: var(--vscode-testing-iconPassed);
        --success-soft: color-mix(in srgb, var(--vscode-testing-iconPassed) 16%, transparent);
        --success-strong: color-mix(in srgb, var(--vscode-testing-iconPassed) 72%, white);
        --warning: var(--vscode-charts-yellow);
        --warning-soft: color-mix(in srgb, var(--vscode-charts-yellow) 16%, transparent);
        --warning-strong: color-mix(in srgb, var(--vscode-charts-yellow) 70%, white);
        --danger: var(--vscode-errorForeground);
        --danger-soft: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent);
        --danger-strong: color-mix(in srgb, var(--vscode-errorForeground) 72%, white);
        --shadow: 0 10px 28px rgba(0, 0, 0, 0.14);
        font-family: var(--vscode-font-family);
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        padding: 16px;
        color: var(--fg);
        background:
          radial-gradient(circle at top right, var(--accent-soft), transparent 34%),
          linear-gradient(180deg, color-mix(in srgb, var(--bg) 92%, black) 0%, var(--bg) 100%);
      }

      button, input {
        font: inherit;
      }

      .app {
        display: grid;
        gap: 16px;
      }

      .hero {
        background: linear-gradient(180deg, var(--panel-strong), var(--panel));
        border: 1px solid var(--panel-border);
        border-radius: 20px;
        padding: 16px;
        box-shadow: var(--shadow);
      }

      .hero-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 6px;
      }

      .hero-title strong {
        font-size: 14px;
        letter-spacing: 0.02em;
      }

      .hero-copy {
        color: var(--muted);
        font-size: 13px;
        line-height: 1.5;
      }

      .hero-paths {
        margin-top: 10px;
        display: grid;
        gap: 4px;
        font-size: 12px;
        color: var(--muted);
      }

      .section {
        display: grid;
        gap: 10px;
      }

      .section-heading {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
      }

      .section-title {
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
      }

      .section-copy {
        font-size: 12px;
        color: var(--muted);
      }

      .tools {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }

      .tool-button, .card-button, .card-button-secondary {
        border: 1px solid var(--panel-border);
        border-radius: 12px;
        background: color-mix(in srgb, var(--panel) 76%, transparent);
        color: var(--fg);
        padding: 10px 12px;
        cursor: pointer;
        transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
      }

      .tool-button:hover, .card-button:hover, .card-button-secondary:hover {
        transform: translateY(-1px);
        border-color: color-mix(in srgb, var(--accent) 40%, var(--panel-border));
      }

      .tool-button {
        text-align: left;
      }

      .tool-title {
        display: block;
        font-size: 13px;
        font-weight: 700;
      }

      .tool-subtitle {
        display: block;
        margin-top: 3px;
        font-size: 12px;
        color: var(--muted);
      }

      .list {
        display: grid;
        gap: 14px;
      }

      .account-card {
        position: relative;
        overflow: hidden;
        border-radius: 20px;
        border: 1px solid var(--panel-border);
        background: linear-gradient(180deg, var(--panel), color-mix(in srgb, var(--panel) 88%, black));
        box-shadow: var(--shadow);
        padding: 16px;
      }

      .account-card.active {
        border-color: color-mix(in srgb, var(--accent) 48%, var(--panel-border));
      }

      .account-card.active::before {
        content: "";
        position: absolute;
        inset: 0 auto 0 0;
        width: 4px;
        background: var(--accent);
      }

      .current-card {
        padding: 18px;
        border-color: color-mix(in srgb, var(--accent) 48%, var(--panel-border));
        background:
          radial-gradient(circle at top right, var(--accent-soft), transparent 30%),
          linear-gradient(180deg, var(--panel-strong), color-mix(in srgb, var(--panel) 88%, black));
      }

      .current-card::before {
        width: 5px;
      }

      .compact-list {
        display: grid;
        gap: 10px;
      }

      .compact-card {
        padding: 14px;
        border-radius: 18px;
        box-shadow: none;
      }

      .account-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 10px;
      }

      .account-title {
        font-size: 16px;
        font-weight: 800;
        line-height: 1.3;
      }

      .account-email {
        margin-top: 4px;
        color: var(--muted);
        font-size: 13px;
        word-break: break-word;
      }

      .badge-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        justify-content: flex-end;
      }

      .badge {
        border-radius: 999px;
        padding: 4px 8px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.03em;
        text-transform: uppercase;
        border: 1px solid var(--panel-border);
        background: color-mix(in srgb, var(--panel-strong) 90%, transparent);
      }

      .badge.active {
        background: var(--accent-soft);
        border-color: color-mix(in srgb, var(--accent) 45%, transparent);
      }

      .usage-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
        margin-top: 12px;
      }

      .usage-grid.current-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
        margin-top: 14px;
      }

      .stat {
        border-radius: 14px;
        padding: 12px;
        border: 1px solid color-mix(in srgb, var(--panel-border) 80%, transparent);
        background: color-mix(in srgb, var(--panel-strong) 86%, transparent);
        min-height: 102px;
      }

      .stat.span-2 {
        grid-column: span 2;
      }

      .stat.status-ok {
        border-color: color-mix(in srgb, var(--success) 36%, transparent);
        background: linear-gradient(180deg, var(--success-soft), color-mix(in srgb, var(--panel-strong) 92%, transparent));
      }

      .stat.status-warn {
        border-color: color-mix(in srgb, var(--warning) 38%, transparent);
        background: linear-gradient(180deg, var(--warning-soft), color-mix(in srgb, var(--panel-strong) 92%, transparent));
      }

      .stat.status-danger {
        border-color: color-mix(in srgb, var(--danger) 34%, transparent);
        background: linear-gradient(180deg, var(--danger-soft), color-mix(in srgb, var(--panel-strong) 92%, transparent));
      }

      .stat-label {
        color: var(--muted);
        font-size: 12px;
        margin-bottom: 8px;
      }

      .stat-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }

      .stat-value {
        font-size: 21px;
        font-weight: 800;
        line-height: 1.1;
      }

      .tone-pill {
        border-radius: 999px;
        padding: 3px 7px;
        font-size: 11px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        border: 1px solid transparent;
        white-space: nowrap;
      }

      .tone-pill.status-ok {
        color: var(--success-strong);
        border-color: color-mix(in srgb, var(--success) 28%, transparent);
        background: var(--success-soft);
      }

      .tone-pill.status-warn {
        color: var(--warning-strong);
        border-color: color-mix(in srgb, var(--warning) 32%, transparent);
        background: var(--warning-soft);
      }

      .tone-pill.status-danger {
        color: var(--danger-strong);
        border-color: color-mix(in srgb, var(--danger) 32%, transparent);
        background: var(--danger-soft);
      }

      .stat-meta {
        margin-top: 6px;
        font-size: 12px;
        color: var(--muted);
      }

      .stat-submeta {
        margin-top: 3px;
        font-size: 11px;
        color: var(--muted);
      }

      .progress {
        margin-top: 8px;
        height: 6px;
        border-radius: 999px;
        background: color-mix(in srgb, var(--panel-border) 55%, transparent);
        overflow: hidden;
      }

      .progress > span {
        display: block;
        height: 100%;
        border-radius: inherit;
        background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 55%, white));
      }

      .progress > span.status-ok {
        background: linear-gradient(90deg, var(--success), color-mix(in srgb, var(--success) 56%, white));
      }

      .progress > span.status-warn {
        background: linear-gradient(90deg, var(--warning), color-mix(in srgb, var(--warning) 56%, white));
      }

      .progress > span.status-danger {
        background: linear-gradient(90deg, var(--danger), color-mix(in srgb, var(--danger) 52%, white));
      }

      .compact-metrics {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 9px;
        margin-top: 12px;
      }

      .metric-chip {
        border-radius: 12px;
        padding: 10px;
        border: 1px solid color-mix(in srgb, var(--panel-border) 75%, transparent);
        background: color-mix(in srgb, var(--panel-strong) 88%, transparent);
        min-height: 84px;
      }

      .metric-chip.span-2 {
        grid-column: span 2;
        min-height: 72px;
      }

      .metric-chip.status-ok {
        border-color: color-mix(in srgb, var(--success) 28%, transparent);
        background: linear-gradient(180deg, var(--success-soft), color-mix(in srgb, var(--panel-strong) 94%, transparent));
      }

      .metric-chip.status-warn {
        border-color: color-mix(in srgb, var(--warning) 30%, transparent);
        background: linear-gradient(180deg, var(--warning-soft), color-mix(in srgb, var(--panel-strong) 94%, transparent));
      }

      .metric-chip.status-danger {
        border-color: color-mix(in srgb, var(--danger) 28%, transparent);
        background: linear-gradient(180deg, var(--danger-soft), color-mix(in srgb, var(--panel-strong) 94%, transparent));
      }

      .metric-label {
        color: var(--muted);
        font-size: 11px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      .metric-value {
        margin-top: 5px;
        font-size: 17px;
        font-weight: 800;
        line-height: 1.15;
      }

      .metric-meta {
        margin-top: 4px;
        font-size: 11px;
        line-height: 1.35;
        color: var(--muted);
      }

      .account-foot {
        margin-top: 12px;
        display: grid;
        gap: 4px;
        font-size: 12px;
        color: var(--muted);
      }

      .compact-foot {
        margin-top: 10px;
        gap: 3px;
        font-size: 11px;
      }

      .account-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 12px;
      }

      .card-button {
        background: var(--accent);
        color: var(--accent-fg);
        border-color: transparent;
        font-weight: 700;
      }

      .card-button[disabled] {
        cursor: default;
        opacity: 0.72;
        transform: none;
      }

      .card-button-secondary {
        font-size: 13px;
      }

      .compact-actions {
        margin-top: 10px;
        gap: 6px;
      }

      .compact-actions .card-button,
      .compact-actions .card-button-secondary {
        padding: 9px 11px;
        font-size: 12px;
      }

      .error {
        border-radius: 14px;
        border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
        background: var(--danger-soft);
        padding: 12px;
        color: var(--fg);
        font-size: 12px;
        line-height: 1.5;
      }

      .restart-banner {
        border-radius: 18px;
        border: 1px solid color-mix(in srgb, var(--warning) 34%, transparent);
        background: linear-gradient(180deg, var(--warning-soft), color-mix(in srgb, var(--panel) 92%, transparent));
        padding: 14px;
        display: grid;
        gap: 10px;
        box-shadow: var(--shadow);
      }

      .restart-banner strong {
        font-size: 13px;
      }

      .restart-banner-copy {
        font-size: 12px;
        color: var(--muted);
        line-height: 1.55;
      }

      .empty {
        border-radius: 18px;
        border: 1px dashed var(--panel-border);
        background: color-mix(in srgb, var(--panel) 72%, transparent);
        padding: 16px;
        display: grid;
        gap: 10px;
      }

      .empty strong {
        font-size: 13px;
      }

      .empty p {
        margin: 0;
        font-size: 13px;
        color: var(--muted);
        line-height: 1.5;
      }

      @media (max-width: 340px) {
        .tools,
        .usage-grid,
        .compact-metrics {
          grid-template-columns: 1fr;
        }

        .stat.span-2,
        .metric-chip.span-2 {
          grid-column: span 1;
        }
      }
    </style>
  </head>
  <body>
    <div id="app" class="app"></div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      let state = null;

      window.addEventListener("message", (event) => {
        const message = event.data;
        if (message?.type === "state") {
          state = message.payload;
          render();
        }
      });

      document.addEventListener("click", (event) => {
        const target = event.target.closest("[data-action]");
        if (!target) {
          return;
        }
        const action = target.dataset.action;
        const id = target.dataset.id;
        vscode.postMessage(id ? { type: action, id } : { type: action });
      });

      setInterval(() => {
        if (state) {
          render();
        }
      }, 60000);

      function render() {
        const root = document.getElementById("app");
        if (!root || !state) {
          return;
        }

        const tools = [
          tool("Save Current", "Capture current auth.json", "saveCurrentAccount"),
          tool("New Login", "Login and auto-capture", "startLogin"),
          tool("Import Bundle", "Bring accounts from file", "importBundle"),
          tool("Export Bundle", "Portable account backup", "exportBundle"),
          tool("Refresh All", "Reload accounts and usage", "refresh"),
          tool("Open Codex Home", "~/.codex files", "openCodexHome"),
        ].join("");

        const accounts = Array.isArray(state.accounts) ? state.accounts : [];
        const restartBanner = state.restart?.thisWindowNeedsReload
          ? renderRestartBanner(state.restart)
          : "";
        const currentAccount = accounts.find((account) => account.isActive) || null;
        const otherAccounts = currentAccount
          ? accounts.filter((account) => account.id !== currentAccount.id)
          : accounts;
        const accountMarkup =
          accounts.length === 0
            ? emptyState()
            : [
                currentAccount ? renderCurrentSection(currentAccount) : "",
                renderOtherSection(otherAccounts, currentAccount),
              ].join("");

        root.innerHTML = \`
          <section class="hero">
            <div class="hero-title">
              <strong>Codex Multi-Account</strong>
              <span class="badge">auth.json only</span>
            </div>
            <div class="hero-copy">\${escapeHtml(state.sharedHint || "")}</div>
            <div class="hero-paths">
              <div><strong>sessions</strong> stay shared across accounts</div>
              <div><strong>memories</strong> stay shared across accounts</div>
              <div><strong>state_5.sqlite</strong> stays shared across accounts</div>
            </div>
          </section>
          \${restartBanner}
          <section class="tools">\${tools}</section>
          \${state.lastError ? \`<section class="error">\${escapeHtml(state.lastError)}</section>\` : ""}
          <section class="list">\${accountMarkup}</section>
        \`;
      }

      function renderRestartBanner(restart) {
        const currentLabel =
          restart.currentWindowAccountLabel || "current window account";
        const liveLabel = restart.liveAccountLabel || "different live auth";
        const revertButton =
          restart.canRevertToWindowAccount && restart.currentWindowAccountId
            ? \`<button class="card-button-secondary" data-action="switchAccount" data-id="\${escapeAttr(restart.currentWindowAccountId)}">Revert auth.json</button>\`
            : "";
        return \`
          <section class="restart-banner">
            <div>
              <strong>Reload needed in this window</strong>
              <div class="restart-banner-copy">
                This window is still using <strong>\${escapeHtml(currentLabel)}</strong>.
                Live <code>auth.json</code> has already switched to <strong>\${escapeHtml(liveLabel)}</strong>.
                \${restart.switchedAt ? \`Switched \${escapeHtml(formatWhen(restart.switchedAt))}.\` : ""}
                Pending windows: \${escapeHtml(String(restart.pendingWindowCount || 1))}.
              </div>
            </div>
            <div class="account-actions">
              <button class="card-button" data-action="reloadWindow">Reload Window</button>
              \${revertButton}
            </div>
          </section>
        \`;
      }

      function renderCurrentSection(account) {
        return \`
          <section class="section">
            <div class="section-heading">
              <div class="section-title">Current Account</div>
              <div class="section-copy">Switching only changes auth.json</div>
            </div>
            \${renderCurrentCard(account)}
          </section>
        \`;
      }

      function renderOtherSection(accounts, currentAccount) {
        if (!accounts.length) {
          return "";
        }

        return \`
          <section class="section">
            <div class="section-heading">
              <div class="section-title">\${currentAccount ? "Other Accounts" : "Managed Accounts"}</div>
              <div class="section-copy">\${escapeHtml(String(accounts.length))} snapshot(s)</div>
            </div>
            <div class="compact-list">
              \${accounts.map((account) => renderCompactCard(account)).join("")}
            </div>
          </section>
        \`;
      }

      function renderCurrentCard(account) {
        const badges = [];
        badges.push('<span class="badge active">Current</span>');
        if (account.planType) {
          badges.push(\`<span class="badge">\${escapeHtml(account.planType)}</span>\`);
        }

        const windows = new Map((account.windows || []).map((window) => [window.key, window]));
        const fiveHour = windows.get("5h");
        const weekly = windows.get("1w");
        const usageMeta = renderUsageMeta(account);

        return \`
          <article class="account-card current-card active">
            <div class="account-head">
              <div>
                <div class="account-title">\${escapeHtml(account.label)}</div>
                <div class="account-email">\${escapeHtml(account.email || account.accountId || "Unknown identity")}</div>
              </div>
              <div class="badge-row">\${badges.join("")}</div>
            </div>

            <div class="usage-grid current-grid">
              \${renderCreditStat(account.creditLabel, true)}
              \${renderWindowStat("5h Window", fiveHour)}
              \${renderWindowStat("1 Week", weekly)}
            </div>

            <div class="account-foot">
              <div>\${usageMeta}</div>
              <div>Captured \${escapeHtml(formatWhen(account.lastCapturedAt))}\${account.lastUsedAt ? \` · Switched \${escapeHtml(formatWhen(account.lastUsedAt))}\` : ""}</div>
              <div>Auth mode: \${escapeHtml(account.authMode || "unknown")}</div>
            </div>

            <div class="account-actions">
              \${account.isActive
                ? '<button class="card-button" disabled>Current account</button>'
                : \`<button class="card-button" data-action="switchAccount" data-id="\${escapeAttr(account.id)}">Switch</button>\`}
              \${state.restart?.thisWindowNeedsReload ? '<button class="card-button-secondary" data-action="reloadWindow">Reload window</button>' : ""}
              \${state.restart?.canRevertToWindowAccount && state.restart?.currentWindowAccountId
                ? \`<button class="card-button-secondary" data-action="switchAccount" data-id="\${escapeAttr(state.restart.currentWindowAccountId)}">Revert auth.json</button>\`
                : ""}
              <button class="card-button-secondary" data-action="refreshUsage" data-id="\${escapeAttr(account.id)}">Refresh usage</button>
              <button class="card-button-secondary" data-action="renameAccount" data-id="\${escapeAttr(account.id)}">Rename</button>
              <button class="card-button-secondary" data-action="removeAccount" data-id="\${escapeAttr(account.id)}">Remove</button>
            </div>
          </article>
        \`;
      }

      function renderCompactCard(account) {
        const badges = [];
        if (account.planType) {
          badges.push(\`<span class="badge">\${escapeHtml(account.planType)}</span>\`);
        }

        const windows = new Map((account.windows || []).map((window) => [window.key, window]));
        const fiveHour = windows.get("5h");
        const weekly = windows.get("1w");

        return \`
          <article class="account-card compact-card">
            <div class="account-head">
              <div>
                <div class="account-title">\${escapeHtml(account.label)}</div>
                <div class="account-email">\${escapeHtml(account.email || account.accountId || "Unknown identity")}</div>
              </div>
              <div class="badge-row">\${badges.join("")}</div>
            </div>

            <div class="compact-metrics">
              \${renderCreditChip(account.creditLabel)}
              \${renderCompactWindowChip("5h", fiveHour)}
              \${renderCompactWindowChip("1w", weekly)}
            </div>

            <div class="account-foot compact-foot">
              <div>\${renderUsageMeta(account, true)}</div>
              <div>Captured \${escapeHtml(formatWhen(account.lastCapturedAt))}\${account.lastUsedAt ? \` · Switched \${escapeHtml(formatWhen(account.lastUsedAt))}\` : ""}</div>
            </div>

            <div class="account-actions compact-actions">
              <button class="card-button" data-action="switchAccount" data-id="\${escapeAttr(account.id)}">Switch</button>
              <button class="card-button-secondary" data-action="refreshUsage" data-id="\${escapeAttr(account.id)}">Refresh</button>
              <button class="card-button-secondary" data-action="renameAccount" data-id="\${escapeAttr(account.id)}">Rename</button>
              <button class="card-button-secondary" data-action="removeAccount" data-id="\${escapeAttr(account.id)}">Remove</button>
            </div>
          </article>
        \`;
      }

      function renderCreditStat(label, emphasize) {
        return \`
          <div class="stat span-2 \${emphasize ? "status-neutral" : ""}">
            <div class="stat-label">Credits</div>
            <div class="stat-value">\${escapeHtml(label || "Unavailable")}</div>
            <div class="stat-meta">Snapshot value from OpenAI usage</div>
            <div class="stat-submeta">Separated from identity info</div>
          </div>
        \`;
      }

      function renderCreditChip(label) {
        return \`
          <div class="metric-chip span-2">
            <div class="metric-label">Credits</div>
            <div class="metric-value">\${escapeHtml(label || "Unavailable")}</div>
            <div class="metric-meta">Usage snapshot</div>
          </div>
        \`;
      }

      function renderWindowStat(title, window) {
        if (!window) {
          return \`
            <div class="stat">
              <div class="stat-label">\${escapeHtml(title)}</div>
              <div class="stat-value">--</div>
              <div class="stat-meta">No window detected</div>
              <div class="stat-submeta">Reset time unavailable</div>
            </div>
          \`;
        }

        const remaining = typeof window.remainingPercent === "number" ? window.remainingPercent : null;
        const progress = remaining == null ? 0 : remaining;
        const tone = getUsageTone(remaining);
        const toneLabel = getUsageToneLabel(tone);
        const absoluteReset = window.resetsAt ? formatResetAbsolute(window.resetsAt) : null;
        const relativeReset = window.resetsAt ? formatResetRelative(window.resetsAt) : null;
        return \`
          <div class="stat \${tone}">
            <div class="stat-label">\${escapeHtml(title)}</div>
            <div class="stat-head">
              <div class="stat-value">\${remaining == null ? "--" : escapeHtml(String(remaining) + "%")}</div>
              \${toneLabel ? \`<span class="tone-pill \${tone}">\${escapeHtml(toneLabel)}</span>\` : ""}
            </div>
            <div class="stat-meta">\${absoluteReset ? \`OpenAI resets \${escapeHtml(absoluteReset)}\` : "Reset time unavailable"}</div>
            <div class="stat-submeta">\${relativeReset ? escapeHtml(relativeReset) : "Waiting for next reset timestamp"}</div>
            <div class="progress"><span class="\${tone}" style="width: \${progress}%;"></span></div>
          </div>
        \`;
      }

      function renderCompactWindowChip(label, window) {
        if (!window) {
          return \`
            <div class="metric-chip">
              <div class="metric-label">\${escapeHtml(label)}</div>
              <div class="metric-value">--</div>
              <div class="metric-meta">No window data</div>
            </div>
          \`;
        }

        const remaining = typeof window.remainingPercent === "number" ? window.remainingPercent : null;
        const tone = getUsageTone(remaining);
        const compactReset = window.resetsAt ? formatResetCompact(window.resetsAt) : "Unknown";
        return \`
          <div class="metric-chip \${tone}">
            <div class="metric-label">\${escapeHtml(label)}</div>
            <div class="metric-value">\${remaining == null ? "--" : escapeHtml(String(remaining) + "%")}</div>
            <div class="metric-meta">\${window.resetsAt ? \`Reset \${escapeHtml(compactReset)}\` : "Reset unavailable"}</div>
          </div>
        \`;
      }

      function renderUsageMeta(account, compact) {
        if (account.usageFetchedAt) {
          const parts = [
            \`Snapshot \${escapeHtml(formatWhen(account.usageFetchedAt))}\`,
          ];
          if (account.usageSourceTimestamp) {
            parts.push(\`Server \${escapeHtml(formatWhen(account.usageSourceTimestamp))}\`);
          }
          if (!compact && account.usageError) {
            parts.push(\`Last error: \${escapeHtml(account.usageError)}\`);
          }
          return parts.join(" · ");
        }

        if (account.usageError) {
          if (account.usageCheckedAt) {
            return \`Last checked \${escapeHtml(formatWhen(account.usageCheckedAt))} · Usage unavailable: \${escapeHtml(account.usageError)}\`;
          }
          return \`Usage unavailable: \${escapeHtml(account.usageError)}\`;
        }

        if (account.usageCheckedAt) {
          return \`Last checked \${escapeHtml(formatWhen(account.usageCheckedAt))}\`;
        }

        return "Usage not loaded yet";
      }

      function getUsageTone(remaining) {
        if (typeof remaining !== "number") {
          return "status-neutral";
        }
        if (remaining <= 20) {
          return "status-danger";
        }
        if (remaining <= 50) {
          return "status-warn";
        }
        return "status-ok";
      }

      function getUsageToneLabel(tone) {
        switch (tone) {
          case "status-danger":
            return "Low";
          case "status-warn":
            return "Watch";
          case "status-ok":
            return "Healthy";
          default:
            return "";
        }
      }

      function formatResetAbsolute(isoString) {
        const date = new Date(isoString);
        if (Number.isNaN(date.getTime())) {
          return isoString;
        }

        const now = new Date();
        const time = new Intl.DateTimeFormat(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        }).format(date);
        const tomorrow = new Date(now);
        tomorrow.setDate(now.getDate() + 1);

        if (isSameDay(date, now)) {
          return \`today at \${time}\`;
        }
        if (isSameDay(date, tomorrow)) {
          return \`tomorrow at \${time}\`;
        }

        return new Intl.DateTimeFormat(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }).format(date);
      }

      function formatResetCompact(isoString) {
        const date = new Date(isoString);
        if (Number.isNaN(date.getTime())) {
          return isoString;
        }

        const now = new Date();
        if (isSameDay(date, now)) {
          return new Intl.DateTimeFormat(undefined, {
            hour: "2-digit",
            minute: "2-digit",
          }).format(date);
        }

        return new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }).format(date);
      }

      function formatResetRelative(isoString) {
        const date = new Date(isoString);
        if (Number.isNaN(date.getTime())) {
          return isoString;
        }

        const diffMs = date.getTime() - Date.now();
        const diffMinutes = Math.round(diffMs / 60000);
        if (Math.abs(diffMinutes) < 60) {
          return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(diffMinutes, "minute");
        }

        const diffHours = Math.round(diffMinutes / 60);
        if (Math.abs(diffHours) < 48) {
          return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(diffHours, "hour");
        }

        const diffDays = Math.round(diffHours / 24);
        return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(diffDays, "day");
      }

      function tool(title, subtitle, action) {
        return \`
          <button class="tool-button" data-action="\${escapeAttr(action)}">
            <span class="tool-title">\${escapeHtml(title)}</span>
            <span class="tool-subtitle">\${escapeHtml(subtitle)}</span>
          </button>
        \`;
      }

      function emptyState() {
        return \`
          <section class="empty">
            <strong>No managed accounts yet</strong>
            <p>Save the current auth snapshot or start a fresh login. New auth.json changes will be auto-captured.</p>
            <div class="account-actions">
              <button class="card-button" data-action="saveCurrentAccount">Save current</button>
              <button class="card-button-secondary" data-action="startLogin">Start new login</button>
            </div>
          </section>
        \`;
      }

      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }

      function escapeAttr(value) {
        return escapeHtml(value);
      }

      function formatWhen(isoString) {
        const date = new Date(isoString);
        if (Number.isNaN(date.getTime())) {
          return isoString;
        }
        const diffMs = Date.now() - date.getTime();
        const diffMinutes = Math.round(diffMs / 60000);
        if (Math.abs(diffMinutes) < 1) {
          return "just now";
        }
        if (Math.abs(diffMinutes) < 60) {
          return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-diffMinutes, "minute");
        }
        const diffHours = Math.round(diffMinutes / 60);
        if (Math.abs(diffHours) < 48) {
          return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-diffHours, "hour");
        }
        return new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }).format(date);
      }

      function isSameDay(left, right) {
        return (
          left.getFullYear() === right.getFullYear() &&
          left.getMonth() === right.getMonth() &&
          left.getDate() === right.getDate()
        );
      }
    </script>
  </body>
</html>`;
  }
}

function createNonce(): string {
  return randomBytes(16).toString("base64");
}
