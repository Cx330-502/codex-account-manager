# Codex Account Manager CLI

`codex-accounts` 是一个全屏 TUI，用来管理多个 Codex / ChatGPT 官方账号快照，并查看 `5h / 1周` usage。

## 特点

- 全屏 TUI，支持方向键上下选择、`Left` / `Right` 切换栏位、`Enter` 确认
- 默认 `manual-only` 模式：不自动刷新任何东西
- 可切到 `usage-auto`：仅在 CLI 运行时自动刷新 usage
- `token refresh` 永远只能手动触发
- 顶栏显示 `HTTP proxy` / `HTTPS proxy` 状态
- 当前 live 账号会用 `LIVE` 和 `CURRENT ...` 显著标记

## 安装

```bash
npm install -g codex-account-manager
```

## 运行

```bash
codex-accounts
```

查看帮助：

```bash
codex-accounts --help
```

## 说明

- `Reload from disk` 只会重新读取本地账号快照、live auth 和已缓存 usage 状态，不会主动发 usage/token 网络请求
- CLI 配置保存在：`~/.codex/account-manager/cli-config.json`
- 账号数据仍然基于 `~/.codex/auth.json` 与 `~/.codex/account-manager/`
