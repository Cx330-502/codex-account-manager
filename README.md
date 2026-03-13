# Codex Account Manager

一个 VS Code 扩展，用来管理多个 Codex / ChatGPT 账号快照。插件只切换 `~/.codex/auth.json`，因此本地 `sessions/`、`memories/`、`state_5.sqlite` 会天然保持共通，不会因为切账号而被分叉。

## 功能

- 底栏状态入口：在 VS Code 状态栏直接显示当前账号 `5h / 1周` 额度，点击即可打开操作菜单
- 侧边栏面板保留：完整账号管理面板仍可在 Explorer 中打开
- 多账号快照管理：把不同账号的 `auth.json` 保存到 `~/.codex/account-manager/accounts/*.json`
- 自动识别新账号：监听 `~/.codex/auth.json`，登录新账号后自动纳入管理
- 一键切换账号：把选中的快照写回 `~/.codex/auth.json`
- 一键导入 / 导出：导出为单个 JSON bundle，方便跨平台迁移
- 使用额度展示：按官方 Codex 扩展的接口规则，展示 `5h` 和 `1周` 两层额度
- usage 更新时间展示：显示本地 snapshot 抓取时间，并尽量显示服务端 `Date` 响应时间
- 跨账号共享本地状态：切换时**不会**改动 `sessions/`、`memories/`、`state_5.sqlite`

## 平台兼容性

- 设计目标支持 Windows / macOS / Linux
- 路径解析支持 `CODEX_HOME`、系统家目录，以及多架构 `codex` 可执行文件定位
- 导入、导出、账号快照、usage 查询都不绑定单一平台

## 快速使用

1. 看底栏 `Codex Accounts` 状态项：会显示当前账号的 `5h / 1周` 剩余额度
2. 点击底栏状态项，直接执行 `Switch / Refresh Usage / Import / Export / Start Login` 等基础操作
3. 需要完整卡片式管理界面时，在 Explorer 打开 `Codex Accounts` 视图
4. 登录新账号后，插件会自动捕获并纳入管理

## 额度显示说明

- 额度查询接口：`https://chatgpt.com/backend-api/wham/usage`
- 展示两层窗口：`5h` 和 `1周`
- 会显示：
  - 本地抓取时间（Snapshot）
  - 服务端响应时间（Server）
  - 两层额度的重置时刻（Reset time）
- 默认有 10 分钟刷新冷却，避免频繁请求；可在设置中改 `codexAccounts.usageRefreshMinIntervalMinutes`

如果网络不可达、接口返回 `401/403/404`、或者某个账号没有可用 usage snapshot，侧边栏会显示 `usage unavailable`，但账号切换本身不受影响。

## 数据与隐私

- 插件只管理以下文件：
  - `~/.codex/auth.json`
  - `~/.codex/account-manager/registry.json`
  - `~/.codex/account-manager/accounts/*.json`
- `Export` 文件包含认证信息，请按密钥文件级别管理

## 当前限制

- `wham/usage` 返回里暂时没有看到专门的“余额最后结算时间”字段；当前展示的是本地抓取时间和服务端 `Date` 响应时间
- 当前没有改动官方 Codex 扩展本体，只是围绕 `~/.codex/auth.json` 做外部管理

## 开发文档

开发与调试请看 [DEVELOPMENT.md](./DEVELOPMENT.md)。
