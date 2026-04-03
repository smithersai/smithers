# Changelog

All notable changes to this project will be documented in this file.

The format follows Keep a Changelog and this project currently tracks SemVer-style release tags.

## [Unreleased]

### Added

- Added runtime smoke scripts for release gating:
  - `scripts/smoke/desktop-runtime-smoke.ts`
  - `scripts/smoke/cli-runtime-smoke.ts`
- Added `scripts/release/build-cli-artifact.sh` to build CLI release archives into `dist/cli`.
- Added `scripts/release/verify-artifact-integrity.sh` to validate non-empty artifacts, reject placeholders, and generate `SHA256SUMS.txt`.
- Added persisted Burns settings with onboarding status tracking, advanced Smithers auth/rootDir/logging controls, and a non-destructive reset endpoint.
- Added a first-run onboarding wizard that redirects new users into app setup before the first workspace flow.
- Added a `Factory Reset` settings action that forgets all Burns state and returns the app to onboarding without deleting repo folders.
- Added aggregate daemon tray status with shared schema/client support for desktop background mode.
- Added a contributor-first documentation path with a Smithers-oriented getting started guide and a root `CONTRIBUTING.md`.

### Changed

- Changed the add-workspace flow to discover existing workflows for selected local repos and to make template workflow seeding an explicit toggle instead of an always-on default.
- Changed Burns approvals to trigger a real Smithers resume after approval and stopped treating approved `waiting-approval` runs as locally finished before Smithers reports a terminal state.

- Hardened canary/stable workflows with runtime smoke checks, strict artifact collection, and artifact integrity verification.
- Simplified first-run onboarding by removing the `rootDir` choice and renaming the final step to `Smithers Settings`.
- Updated release docs and README entries for new smoke and release artifact commands.
- Reworked the root README and docs index to emphasize onboarding, contributor quick start, desktop development, and where to find deeper reference docs.
- Changed the desktop shell to stay alive in the tray after closing the main window, using bundled black/white tray icons and native tray actions for opening Burns, pending approvals, running workflows, and `Exit (Stop Server)`.
- Changed desktop mode to share the default `~/.burns` app data root with CLI/direct daemon runs, while keeping `BURNS_DESKTOP_DATA_ROOT` as an explicit desktop-only override.
- Changed packaged desktop startup to fail closed when another Burns daemon is already listening on the configured desktop URL, while `bun run dev` still opts into attaching to an existing daemon for local development.
- Added local workspace `Open Folder` and `Copy Path` actions, and changed workflow path copying to return the raw folder path instead of a `cd` command.
- Replaced the read-only settings page with editable forms that save daemon defaults and preserve existing workspaces during reset.
- Removed automatic default-workspace seeding so first-run users land in onboarding instead of a precreated workspace.
- Moved repo-local workflow and Smithers state storage from `.burns`/legacy `.mr-burns` into `.smithers`, with one-time migration of legacy workspace directories and top-level `smithers.db*` files.
- Changed default workspace creation root to `~/Documents/Burns`, while Burns app state now defaults to `~/.burns` for direct daemon/web runs and platform app-data locations in desktop mode.
- Managed workspace runs now create a workspace-local `node_modules` link back to the Burns monorepo so Smithers workflow imports resolve reliably under Bun.
- Reworked the run detail layout so the event timeline stays pinned to the top and the node list/output panes fill the remaining page height.
- Added a run approval workflow in the web UI with pending approval cards on run detail, workspace approvals, and the global inbox, and fixed node output rendering for plain-text Smithers outputs.
- Changed the run detail page to show node cards and outputs in chronological execution order, with pending approvals pinned to the end and per-node start/finish checkpoints.
- Removed the dedicated workspace approvals page and changed the global inbox to link operators directly into the relevant run detail for approval decisions.
