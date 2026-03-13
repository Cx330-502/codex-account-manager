# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog.

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
