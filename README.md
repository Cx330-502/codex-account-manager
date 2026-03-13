# Codex Account Manager

一个 VS Code 扩展，用来管理多个 Codex / ChatGPT 账号快照。插件只切换 `~/.codex/auth.json`，因此本地 `sessions/`、`memories/`、`state_5.sqlite` 会天然保持共通，不会因为切账号而被分叉。

## 当前实现

- 多账号快照管理：把不同账号的 `auth.json` 保存到 `~/.codex/account-manager/accounts/*.json`
- 自动识别新账号：监听 `~/.codex/auth.json`，登录新账号后自动纳入管理
- 一键切换账号：把选中的快照写回 `~/.codex/auth.json`
- 一键导入 / 导出：导出为单个 JSON bundle，方便跨平台迁移
- 使用额度展示：按官方 Codex 扩展的接口规则，展示 `5h` 和 `1周` 两层额度
- usage 更新时间展示：显示本地 snapshot 抓取时间，并尽量显示服务端 `Date` 响应时间
- 跨账号共享本地状态：切换时**不会**改动 `sessions/`、`memories/`、`state_5.sqlite`

## 平台兼容性

- 目录与路径处理基于 `os.homedir()`、`path.resolve()`、`CODEX_HOME`，设计上兼容 Windows / macOS / Linux
- `codex` 可执行文件定位已覆盖 `win32 / darwin / linux` 以及 `x64 / arm64`
- 导入、导出、账号快照、usage 查询本身没有绑定单一平台
- 当前实际开发和运行验证主要在 Linux / WSL 环境完成；Windows 与 macOS 属于按实现兼容，但未在这台机器上逐台实机验证

## 已确认的 `~/.codex` 结构

本机实际看到的关键文件/目录包括：

- `auth.json`
- `config.toml`
- `sessions/`
- `memories/`
- `state_5.sqlite`
- `session_index.jsonl`
- `models_cache.json`

这个插件当前只会读写：

- `~/.codex/auth.json`
- `~/.codex/account-manager/registry.json`
- `~/.codex/account-manager/accounts/*.json`

## 额度说明

额度展示基于本地已安装的官方 Codex 扩展源码行为整理出来：

- 请求地址：`https://chatgpt.com/backend-api/wham/usage`
- 鉴权：`Authorization: Bearer <access_token>`
- 账号头：`ChatGPT-Account-Id`
- 展示策略：优先显示通用 core limit 的 `5h` 与 `1周` 两层窗口
- 当前已在本机实测确认真实返回包含 `limit_window_seconds=18000` 和 `604800`，分别对应 `5h` 与 `1周`
- `5h / 1周` 的具体重置时刻来自窗口字段里的 `reset_at`；如果某次只返回 `reset_after_seconds`，插件会回退换算出绝对重置时间
- 当前已在本机实测确认响应头包含 `Date`，插件会把它作为 usage 数据来源时间展示
- 在 WSL / 代理环境里，请求会优先走 `curl`，再回退到 Node `fetch`
- 为避免频繁请求，默认对同一账号设置 `10` 分钟 usage 刷新冷却；可通过 `codexAccounts.usageRefreshMinIntervalMinutes` 调整，设为 `0` 可关闭

如果网络不可达、接口返回 `401/403/404`、或者某个账号没有可用 usage snapshot，侧边栏会显示 `usage unavailable`，但账号切换本身不受影响。

## 登录新账号

1. 在侧边栏点击 `Start New Login`
2. 插件会先保存当前账号快照
3. 它会打开一个终端并执行 `codex login`
4. 登录完成后，只要 `~/.codex/auth.json` 被更新，插件就会自动捕获新账号

## 导入 / 导出

- 导出：把全部托管账号导出为一个 JSON 文件
- 导入：把另一个设备导出的 JSON bundle 导入进来

注意：bundle 内含完整认证信息，属于敏感文件。

## 开发

```bash
cd codex-account-manager
npm install
npm run build
```

然后用 VS Code 打开这个目录，按 `F5` 启动 Extension Development Host。

### WSL 调试

如果你在 WSL 里开发：

- 请直接打开项目根目录（`codex-account-manager`）
- 不要停留在父目录再按 `F5`
- 这个项目已经带了 `.vscode/launch.json` 和 `.vscode/tasks.json`
- `package.json` 里把扩展标成了 `workspace` extension，所以开发宿主会跑在 WSL 侧，能直接访问 `~/.codex`

## 当前限制

- `wham/usage` 返回里暂时没有看到专门的“余额最后结算时间”字段；当前展示的是本地抓取时间和服务端 `Date` 响应时间
- 当前没有改动官方 Codex 扩展本体，只是围绕 `~/.codex/auth.json` 做外部管理
