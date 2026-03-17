# Codex Account Manager

一个 VS Code 扩展，用来管理多个 Codex / ChatGPT 官方账号快照。插件只切换 `~/.codex/auth.json`，因此本地 `sessions/`、`memories/`、`state_5.sqlite` 会天然保持共通，不会因为切账号而被分叉。

## 功能

- 启动即显示底栏状态：VS Code 启动完成后自动激活，状态栏无需先打开侧边栏
- 底栏状态入口：在 VS Code 状态栏直接显示当前账号 `5h / 1周` 额度，点击即可打开侧边栏
- Reload / Revert 提示：只要磁盘上的 `auth.json` 和当前窗口加载的账号不同，就会显示 `Reload Window`，并可一键 `Revert auth.json`
- 跨窗口同步提醒：如果同时开着多个 VS Code 窗口，其他窗口也会看到“等待重启”的提示；判定依据是“实际磁盘 auth”和“各窗口自身 runtime 账号”是否一致
- 多账号快照管理：把不同账号的 `auth.json` 保存到 `~/.codex/account-manager/accounts/*.json`
- 自动识别新账号：监听 `~/.codex/auth.json`，登录新账号后自动纳入管理
- 干净登录新账号：`Start Login` 会先保存当前账号，再执行一次干净的 `codex logout && codex login`
- 一键切换账号：把选中的快照写回 `~/.codex/auth.json`
- 一键导入 / 导出：导出为单个 JSON bundle，方便跨平台迁移
- 使用额度展示：按官方 Codex 扩展的接口规则，展示 `5h` 和 `1周` 两层额度
- usage 后台刷新：窗口开着时自动按间隔刷新 usage，并在多窗口之间共享刷新结果
- 手动刷新不受冷却：点击 `Refresh Usage` 会立刻请求；`codexAccounts.usageRefreshMinIntervalMinutes` 只约束自动刷新
- 自动续 token：usage 刷新前会尽量自动续 `refresh_token`；若自动续失败，会明确展示错误
- usage 更新时间展示：显示本地 snapshot 抓取时间，并尽量显示服务端 `Date` 响应时间
- 跨账号共享本地状态：切换时**不会**改动 `sessions/`、`memories/`、`state_5.sqlite`

## 平台兼容性

- 设计目标支持 Windows / macOS / Linux
- 路径解析支持 `CODEX_HOME`、系统家目录，以及多架构 `codex` 可执行文件定位
- 导入、导出、账号快照、usage 查询都不绑定单一平台

## 快速使用

1. 启动 VS Code 后直接看底栏 `Codex Accounts` 状态项：会显示当前账号的 `5h / 1周` 剩余额度
2. 点击底栏状态项，直接打开完整的 `Codex Accounts` 侧边栏
3. 在侧边栏里执行 `Switch / Refresh Usage / Reload Window / Revert auth.json / Import / Export / Start Login` 等操作
4. 只要当前窗口所用账号和磁盘上的 live `auth.json` 不一致，就会看到明确的 `Reload Window` 和 `Revert auth.json` 提示
5. `Start Login` 会先保存当前账号，再启动干净登录；登录新账号后，插件会自动捕获并纳入管理

## 额度显示说明

- 额度查询接口：`https://chatgpt.com/backend-api/wham/usage`
- 展示两层窗口：`5h` 和 `1周`
- 会显示：
  - 本地抓取时间（Snapshot）
  - 服务端响应时间（Server）
  - 两层额度的重置时刻（Reset time）
- 默认有 10 分钟自动刷新冷却；窗口保持打开时会自动刷新，可在设置中改 `codexAccounts.usageRefreshMinIntervalMinutes`
- 手动点击 `Refresh Usage` 时不会受这个冷却限制
- 多个 VS Code 窗口会共享 refresh 结果，并尽量避免重复打接口
- 对带 `refresh_token` 的账号，会优先尝试自动续 token；如果自动续失败，会把失败原因显示在状态栏 / 侧边栏中

如果网络不可达、接口返回 `401/403/404`、或者某个账号没有可用 usage snapshot，侧边栏会显示 `usage unavailable`，但账号切换本身不受影响。

## 数据与隐私

- 插件只管理以下文件：
  - `~/.codex/auth.json`
  - `~/.codex/account-manager/registry.json`
  - `~/.codex/account-manager/runtime.json`
  - `~/.codex/account-manager/accounts/*.json`
- `Export` 文件包含认证信息，请按密钥文件级别管理

## 当前限制

- 切换账号或重新登录后，**新开的** Codex 会话会使用磁盘上的 live `auth.json`；已经在跑的旧 Codex 进程仍可能继续使用旧账号，直到相关窗口 / 终端重启
- `wham/usage` 返回里暂时没有看到专门的“余额最后结算时间”字段；当前展示的是本地抓取时间和服务端 `Date` 响应时间
- 当前没有改动官方 Codex 扩展本体，只是围绕 `~/.codex/auth.json` 做外部管理

## 开发文档

开发与调试请看 [DEVELOPMENT.md](./DEVELOPMENT.md)。
