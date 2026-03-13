# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog.

## [0.1.3] - 2026-03-13

- Added a dedicated Marketplace extension icon (`media/icon.png`) and wired it in `package.json`.

## [0.1.2] - 2026-03-13

- Aligned the extension publisher with the existing Marketplace publisher.
- Prepared the package metadata for Marketplace publication after GitHub release setup.

## [0.1.1] - 2026-03-13

- Increased sidebar typography across cards, tool buttons, metadata, and compact rows.
- Reflowed the current-account and compact-account layouts so larger text remains readable in the sidebar.
- Kept `5h` and `1w` reset time display visible after the larger typography update.
- Added GitHub repository metadata and project links to the extension manifest and README.

## [0.1.0] - 2026-03-13

- Initial public release of the extension.
- Added managed multi-account snapshots for `~/.codex/auth.json`.
- Added account switching, renaming, removal, import, and export.
- Added auto-capture when `~/.codex/auth.json` changes after a new login.
- Kept local `sessions/`, `memories/`, and `state_5.sqlite` shared across accounts.
- Added usage detection for `5h` and `1w` quota windows from `https://chatgpt.com/backend-api/wham/usage`.
- Added usage snapshot time, server response time, reset time display, and refresh throttling.
- Added a card-based sidebar UI for current and managed accounts.
