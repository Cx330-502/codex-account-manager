# TODO

## Account/Auth

- [ ] Investigate cross-device token rotation conflicts (WSL/Windows import-export): old snapshots show auth-expired after token refresh on another device.
- [ ] Improve imported snapshot UX: avoid showing stale `usageError` ("auth expired"/"network") immediately after import.
- [ ] Document safe multi-device strategy (single refresh authority vs separate logins per environment).

## Usage Refresh

- [ ] Diagnose why background auto-refresh can record network failure while manual refresh succeeds.
- [ ] Add better diagnostics for auto-refresh path (attempt id, trigger reason, curl/fetch stage, account id, duration).
- [ ] Consider separate failure state for transient background failures so UI does not over-signal.

## Cross-Environment Stability

- [ ] Investigate Codex behavior when mixing Windows native + WSL + SSH windows concurrently.
- [ ] Build a reproducible matrix (Win native, WSL remote, SSH remote, mixed) and collect logs for each case.

## CLI Productization

- [ ] Design standalone CLI (`codex-account-manager`) for account switching (not VS Code-only).
- [ ] Reuse store/auth modules for commands: `list/save/switch/import/export/run`.
- [ ] Add `run` wrapper mode: switch account then execute `codex ...` with atomic restore/safety options.
