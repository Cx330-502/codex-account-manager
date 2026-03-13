# Development Guide

This file is for contributors. End-user usage is documented in `README.md`.

## Prerequisites

- Node.js 20+
- npm
- VS Code 1.95+

## Local Build

```bash
npm install
npm run build
```

## Run In Extension Development Host

1. Open the project root folder (`codex-account-manager`) in VS Code.
2. Press `F5` to launch the Extension Development Host.

WSL notes:

- Open this project folder directly from WSL.
- Do not press `F5` from the parent workspace directory.
- `.vscode/launch.json` and `.vscode/tasks.json` are already configured.

## Package VSIX

```bash
npx @vscode/vsce package
```

## Publish

Manual upload:

1. Build a `.vsix` package.
2. Upload it from the Visual Studio Marketplace publisher portal.

CLI publish:

```bash
export VSCE_PAT='your-token'
npx @vscode/vsce publish
```

## Notes

- This extension only switches `~/.codex/auth.json`.
- Local `sessions/`, `memories/`, and `state_5.sqlite` remain shared across managed accounts by design.
