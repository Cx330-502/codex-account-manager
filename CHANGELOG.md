# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog.

## [0.2.9] - 2026-03-25

- Fixed status bar and sidebar "current account" usage to follow the account currently loaded by this VS Code window, not the latest disk `auth.json`.
- Kept reload/revert prompts tied to live `auth.json`, so window-vs-live divergence is still explicit after switching accounts.
- Changed startup flow to render cached local state first and kick off the first background usage refresh asynchronously, avoiding slow initial extension paint.

## [0.2.8] - 2026-03-25

- Added a dedicated npm CLI package for `codex-accounts`, including the full-screen TUI and manual-only token refresh flow.
- Split packaging boundaries so VSIX builds no longer include the CLI/TUI entrypoint or CLI publish directory.
- Updated CLI UX copy to `Reload from disk` and clarified local-only reload semantics in the docs.

## [0.2.6] - 2026-03-24

- Added configurable sidebar account sorting by `5h`/`1w` reset time and remaining quota, with ascending and descending modes.
- Fixed post-reload account visibility by preserving the last good sidebar state when a startup refresh fails and scheduling automatic refresh recovery retries.
- Tuned background usage refresh behavior: network/service retries now wait longer between attempts, and transient failures are only surfaced after repeated consecutive background failures.
- Added repository TODO tracking for cross-environment auth/refresh stability, CLI productization, and mixed WSL/SSH investigation tasks.

## [0.2.5] - 2026-03-24

- Fixed the sidebar's initial webview state handshake so the first open no longer intermittently renders empty until `Refresh All` is clicked.

## [0.2.4] - 2026-03-24

- Added per-account `Re-login replace` flow: re-login now replaces the selected managed entry instead of creating a new snapshot first.
- Improved usage refresh error UX with explicit error type labels (for example network/auth) plus separate detailed error text.
- Fixed runtime state robustness: added atomic JSON writes, runtime state lock coordination across windows, and runtime corruption auto-recovery.
- Improved background usage refresh stability with in-flight guarding, higher request timeout, and retry/backoff pacing for transient network/service failures.
- Updated extension debug launch config so `F5` opens the current workspace directly.

## [0.2.3] - 2026-03-19

- Improved `Refresh Usage` failure diagnostics by classifying failures into token, network, and service-side errors.
- Added a `Reload Window` action suggestion for network-related refresh failures.
- Clarified manual refresh warning messages so users can quickly tell whether they should re-login or retry later.

## [0.2.2] - 2026-03-17

- Fixed account fingerprinting for team/workspace-shared environments by preferring user-scoped claims like `email` and `sub` over shared workspace ids, so distinct accounts no longer collapse into one managed snapshot.

## [0.2.1] - 2026-03-17

- Fixed `Start New Login` so it now saves the current snapshot first, then starts a clean `codex logout` + `codex login` flow instead of reusing the old live auth state.
- Changed reload detection to compare each window's runtime account with the actual live `~/.codex/auth.json`, so login-driven auth changes now surface the same reload warning as account switching.
- Added `Revert auth.json` actions in the sidebar and status bar when the current window and live auth diverge.
- Changed manual `Refresh Usage` so it bypasses the configured cooldown; `codexAccounts.usageRefreshMinIntervalMinutes` now only throttles background auto-refresh.

## [0.2.0] - 2026-03-17

- Added startup activation so the status bar appears without opening the sidebar first.
- Added cross-window switch markers and reload warnings, including a dedicated `Reload Window` action.
- Added shared runtime state so all open VS Code windows can see pending-account-switch status.
- Added background usage refresh while windows stay open, coordinated across windows to avoid duplicate refresh loops.
- Added automatic Codex token refresh before usage fetches, plus visible refresh failure errors for expired accounts.

## [0.1.2] - 2026-03-13

- Simplified status bar behavior: clicking the quota item now opens the full sidebar directly.
- Removed the temporary quick popup action menu from the status bar flow.

## [0.1.1] - 2026-03-13

- Moved the full accounts panel back to a dedicated `Codex Accounts` sidebar container.
- Kept the status bar as primary entry and switched it to quota-only text (`5h` and `1w`) without account name.
- Added a compact quick menu from the status bar for common actions plus opening the full sidebar.
- Added configurable status bar position (`codexAccounts.statusBarAlignment`: `left` or `right`).

## [0.1.0] - 2026-03-13

- First Marketplace release of the extension.
- Added managed multi-account snapshots for `~/.codex/auth.json`.
- Added account switching, renaming, removal, import, and export.
- Added auto-capture when `~/.codex/auth.json` changes after a new login.
- Kept local `sessions/`, `memories/`, and `state_5.sqlite` shared across accounts.
- Added usage detection for `5h` and `1w` quota windows from `https://chatgpt.com/backend-api/wham/usage`.
- Added usage snapshot time, server response time, reset time display, and refresh throttling.
- Added a card-based sidebar UI for current and managed accounts.
- Added a dedicated extension icon (`media/icon.png`).
- Split user-facing docs and contributor docs (`README.md` and `DEVELOPMENT.md`).
