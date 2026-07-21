const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");
const vm = require("node:vm");

const originalLoad = Module._load;
let installedExtension;
let openedUri;
Module._load = function loadWithVscodeStub(request, parent, isMain) {
  if (request === "vscode") {
    return {
      commands: { executeCommand() {} },
      env: {
        clipboard: { writeText() {} },
        openExternal(uri) { openedUri = uri; },
      },
      extensions: { getExtension() { return installedExtension; } },
      Uri: { parse(value) { return value; } },
      window: { showInformationMessage() {}, showWarningMessage() {} },
      workspace: {
        getConfiguration() {
          return { get(_key, fallback) { return fallback; } };
        },
        onDidChangeConfiguration() {
          return { dispose() {} };
        },
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { CodexAccountsSidebarProvider } = require("../out/sidebar.js");

test("emits syntactically valid Webview JavaScript and the native CLI promotion", () => {
  const provider = new CodexAccountsSidebarProvider(
    {},
    {
      getState() { return {}; },
      onDidChangeState() { return { dispose() {} }; },
    },
    {
      globalState: {
        get(_key, fallback) { return fallback; },
        update() {},
      },
    },
  );
  const html = provider.getHtml({ cspSource: "test-resource" });
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];

  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(html, /直接运行 Codex、Claude Code、Gemini CLI 等厂商原生 CLI/);
  assert.match(html, /无需等待中间层适配，第一时间体验 Agent 厂商最新功能/);
  assert.match(html, /renderWindowStats\(account\.windows/);
});

test("dismisses the one-campaign promotion after opening its extension page", async () => {
  const storage = new Map();
  const provider = new CodexAccountsSidebarProvider(
    {},
    {
      getState() { return {}; },
      onDidChangeState() { return { dispose() {} }; },
    },
    {
      globalState: {
        get(key, fallback) { return storage.get(key) ?? fallback; },
        update(key, value) { storage.set(key, value); },
      },
    },
  );

  installedExtension = undefined;
  openedUri = undefined;
  assert.equal(provider.shouldShowPromotion(), true);
  await provider.handleMessage({ type: "openAgentTerminalPanel" });
  assert.equal(provider.shouldShowPromotion(), false);
  assert.equal(openedUri, "vscode:extension/cx330-502.agent-terminal-panel");

  storage.clear();
  installedExtension = {};
  assert.equal(provider.shouldShowPromotion(), false);
});
