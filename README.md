# Codex Account Manager

> `3.1.0` 是计划中的最终功能版本；后续以兼容性与安全维护为主。

一个 VS Code 扩展，用来管理多个 Codex / ChatGPT 官方账号快照。插件只切换 `~/.codex/auth.json`，因此本地 `sessions/`、`memories/`、`state_5.sqlite` 会天然保持共通，不会因为切账号而被分叉。

仓库现在也提供同源 CLI：`codex-accounts`。CLI 是全屏 TUI，支持方向键上下选择、回车确认和静默状态刷新；默认是手动模式，可切到 `usage-auto`，但依然坚持“`usage` 可以自动刷新，`token refresh` 必须手动触发”。

发布结构已经拆分：

- VS Code 扩展 VSIX 只包含扩展本体，不再打包 TUI/CLI 入口
- npm 包 `codex-account-manager` 只发布 CLI：`codex-accounts`

## 功能

- 启动即显示底栏状态：VS Code 启动完成后自动激活，状态栏无需先打开侧边栏
- 底栏状态入口：在 VS Code 状态栏直接显示接口实际返回的额度窗口，点击即可打开侧边栏
- Reload / Revert 提示：只要磁盘上的 `auth.json` 和当前窗口加载的账号不同，就会显示 `Reload Window`，并可一键 `Revert auth.json`
- 跨窗口同步提醒：如果同时开着多个 VS Code 窗口，其他窗口也会看到“等待重启”的提示；判定依据是“实际磁盘 auth”和“各窗口自身 runtime 账号”是否一致
- 多账号快照管理：把不同账号的 `auth.json` 保存到 `~/.codex/account-manager/accounts/*.json`
- 自动识别新账号：监听 `~/.codex/auth.json`，登录新账号后自动纳入管理
- 干净登录新账号：`Start Login` 会先保存当前账号，再执行一次干净的 `codex logout && codex login`
- Team / workspace 共用场景可分离：同一个 team / workspace 下的不同账号会按用户身份分别建档，不再错误合并
- 一键切换账号：把选中的快照写回 `~/.codex/auth.json`
- 一键导入 / 导出：导出为单个 JSON bundle，方便跨平台迁移
- 动态额度展示：不再假定账号一定有 `5h` 限额；按接口实际返回的窗口长度展示周、月或未来的新窗口，同时兼容旧的短周期窗口
- 重置次数与时间：显示可用 rate-limit reset credits 数量，并尽量读取最近过期时间；当前只读，不会误消费重置次数
- Token 健康状态：显示 access / refresh / ID token 是否存在、脱敏指纹、JWT 过期时间与最近刷新时间
- 安全复制 Token：只有明确点击复制后，扩展宿主才会把指定 token 写入剪贴板；原始 token 不会进入 Webview DOM
- 侧边栏排序可配置：支持按接口返回的最短 / 最长额度窗口的重置时间或剩余额度排序
- usage 后台刷新：窗口开着时自动按间隔刷新 usage，并在多窗口之间共享刷新结果；首次打开扩展会先显示本地缓存，再异步开始后台刷新
- 手动刷新不受冷却：点击 `Refresh Usage` 会立刻请求；`codexAccounts.usageRefreshMinIntervalMinutes` 只约束自动刷新
- 自动续 token：usage 刷新前会尽量自动续 `refresh_token`；若自动续失败，会明确展示错误
- usage 更新时间展示：显示本地 snapshot 抓取时间，并尽量显示服务端 `Date` 响应时间
- 跨账号共享本地状态：切换时**不会**改动 `sessions/`、`memories/`、`state_5.sqlite`

## 平台兼容性

- 设计目标支持 Windows / macOS / Linux
- 路径解析支持 `CODEX_HOME`、系统家目录，以及多架构 `codex` 可执行文件定位
- 导入、导出、账号快照、usage 查询都不绑定单一平台

## 快速使用

1. 启动 VS Code 后直接看底栏 `Codex Accounts` 状态项：会显示当前窗口已加载账号的实际额度窗口与剩余额度
2. 点击底栏状态项，直接打开完整的 `Codex Accounts` 侧边栏
3. 在侧边栏里执行 `Switch / Refresh Usage / Reload Window / Revert auth.json / Import / Export / Start Login` 等操作
4. 只要当前窗口所用账号和磁盘上的 live `auth.json` 不一致，就会看到明确的 `Reload Window` 和 `Revert auth.json` 提示；状态栏和侧边栏顶部依然显示当前窗口自己的 usage
5. `Start Login` 会先保存当前账号，再启动干净登录；登录新账号后，插件会自动捕获并纳入管理

## CLI 使用

- 构建后可直接运行：`node out/cli.js`
- 安装到全局后可直接运行：`codex-accounts`
- 查看帮助：`codex-accounts --help`
- 交互方式：方向键上下移动，`Left` / `Right` 切换菜单和账号面板，`Enter` 确认，`Tab` 也可切换栏位，`Esc` 返回菜单，`q` 退出
- CLI 配置保存在：`~/.codex/account-manager/cli-config.json`
- `Reload from disk` 的意思是：重新读取本地账号快照、live `auth.json` 和已缓存 usage 状态，不会主动请求 usage/token 接口
- CLI 支持两种模式：
  - `manual-only`：默认模式，不做后台刷新，`usage` 和 `token` 都需要你手动触发
  - `usage-auto`：仅在 CLI 正在运行时自动刷新 `usage`，但**绝不**自动 refresh token
- 顶栏会显示当前 `HTTP proxy` / `HTTPS proxy` 状态，右侧账号表会对当前 live 账号显示 `LIVE` 和 `CURRENT ...` 强调
- CLI 里支持：
  - `Refresh usage`
  - `Refresh token`
  - `Switch account`
  - `Save current auth`
  - `Rename account`
  - `Remove account`
  - `Import bundle`
  - `Export bundle`

## 额度与认证状态说明

- 额度查询接口：`https://chatgpt.com/backend-api/wham/usage`
- 窗口完全按响应里的 `limit_window_seconds` / `window_minutes` 动态命名，不再写死为两层额度
- 会显示：
  - 本地抓取时间（Snapshot）
  - 服务端响应时间（Server）
  - 每个额度窗口的重置时刻（Reset time）
  - 可用 rate-limit reset credits 数量与最近过期时间（接口支持时）
  - access / refresh / ID token 的存在性、指纹、过期与刷新时间
- 默认有 10 分钟自动刷新冷却；窗口保持打开时会自动刷新，可在设置中改 `codexAccounts.usageRefreshMinIntervalMinutes`
- 扩展首次打开时会优先读取磁盘里已有的 usage snapshot / error，再异步启动第一次后台刷新
- 侧边栏账号顺序可通过 `codexAccounts.sidebarSortOrder` 配置
- 手动点击 `Refresh Usage` 时不会受这个冷却限制
- 多个 VS Code 窗口会共享 refresh 结果，并尽量避免重复打接口
- 对带 `refresh_token` 的账号，会优先尝试自动续 token；如果自动续失败，会把失败原因显示在状态栏 / 侧边栏中
- Token 复制操作由扩展宿主直接读取本地快照并写入系统剪贴板，Webview 只接收脱敏摘要

如果网络不可达、接口返回 `401/403/404`、或者某个账号没有可用 usage snapshot，侧边栏会显示 `usage unavailable`，但账号切换本身不受影响。

## 数据与隐私

- 插件只管理以下文件：
  - `~/.codex/auth.json`
  - `~/.codex/account-manager/registry.json`
  - `~/.codex/account-manager/runtime.json`
  - `~/.codex/account-manager/accounts/*.json`
- `Export` 文件包含认证信息，请按密钥文件级别管理
- 复制的 token 会短暂存在于系统剪贴板，请在使用后覆盖剪贴板内容

## 当前限制

- 切换账号或重新登录后，**新开的** Codex 会话会使用磁盘上的 live `auth.json`；已经在跑的旧 Codex 进程仍可能继续使用旧账号，直到相关窗口 / 终端重启
- `wham/usage` 与 reset-credit 接口属于 Codex 使用中的后端接口，字段可能继续演进；插件会忽略缺失字段并保留最后一次有效快照
- 当前没有改动官方 Codex 扩展本体，只是围绕 `~/.codex/auth.json` 做外部管理

## 开发文档

开发与调试请看 [DEVELOPMENT.md](./DEVELOPMENT.md)。
