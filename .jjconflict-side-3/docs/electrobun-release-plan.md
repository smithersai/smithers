# ElectroBun Release Plan (Daemon + Webapp + CLI)

Last updated: 2026-03-11
Status: Draft implementation plan

## Goal

Create two supported distribution methods for Burns:

1. Desktop app distribution via ElectroBun that bundles and launches:
- the daemon runtime
- the webapp UI

2. CLI distribution path that can run and distribute the daemon + webapp without the desktop shell.

## Scope

In scope:

- New `apps/desktop` ElectroBun app package
- Runtime contract so the webapp can talk to daemon in all environments (dev, desktop, CLI)
- Packaging daemon + web assets into desktop release artifacts
- CLI commands and packaging path for daemon + webapp runtime
- CI release workflow for canary and stable channels

Out of scope:

- New product features unrelated to distribution
- New backend domain APIs except what is required for bootstrap/runtime wiring
- Backward-compatibility shims unless required by explicit decision

## Constraints and Inputs

- Current repo is a Bun monorepo with `apps/daemon` and `apps/web`.
- Webapp currently defaults to `http://localhost:7332` (`VITE_BURNS_API_URL` override).
- ElectroBun supports:
  - `build.bun`, `build.views`, `build.copy`
  - `electrobun build --env=dev|canary|stable`
  - lifecycle hooks (`preBuild`, `postBuild`, `postWrap`, `postPackage`)
  - release settings (`release.baseUrl`, `release.generatePatch`)
- Cross-platform builds should be treated as CI matrix jobs per OS/arch.

## Target Architecture

Desktop (ElectroBun):

1. ElectroBun Bun entrypoint starts daemon bootstrap in-process (or controlled subprocess if needed).
2. Web assets are bundled into `views://` resources.
3. BrowserWindow loads `views://.../index.html`.
4. Webapp receives runtime API URL from desktop runtime contract.

CLI:

1. CLI command starts daemon.
2. CLI serves or launches prebuilt webapp bundle.
3. Same runtime API URL contract is used as desktop/web dev.

## Phase Plan

## Phase 0: Decision Spike and Contracts (1-2 days)

Outcomes:

- Final decision on daemon execution mode for desktop:
  - in-process bootstrap (preferred if low risk)
  - subprocess daemon (fallback)
- Final runtime config contract for webapp API base URL.

Deliverables:

- ADR: daemon bootstrap mode and rationale
- ADR: runtime API URL contract (priority order and fallback behavior)
- Minimal bootstrap interface for daemon (`start`, `stop`, `port`, `health`)

Parallel work streams:

- Stream A (Agent: Architecture): daemon bootstrap options, failure modes, shutdown behavior
- Stream B (Agent: Frontend Platform): runtime config design for webapp API URL
- Stream C (Agent: Release): ElectroBun build/release constraints and artifact naming contract

Dependency:

- This phase gates all implementation phases.

Exit criteria:

- Two ADRs merged
- Bootstrap and runtime config interface approved

## Phase 1: Foundation Refactors (2-3 days)

Outcomes:

- Daemon can be started programmatically for desktop/CLI orchestration.
- Webapp can resolve API URL from runtime config, env, and fallback.

Deliverables:

- Daemon `startDaemon`/`stopDaemon` module with deterministic lifecycle
- Web API resolution utility with unit tests
- Shared runtime config type for desktop + CLI + web

Parallel work streams:

- Stream A (Agent: Daemon Runtime, file ownership: `apps/daemon/src/main.ts`, `apps/daemon/src/server/*`, `apps/daemon/src/config/*`)
- Stream B (Agent: Web Runtime Config, file ownership: `apps/web/src/lib/api/*`, `apps/web/src/app/*`)
- Stream C (Agent: Shared Types, file ownership: `packages/shared/src/*`, `packages/client/src/*`)

Dependencies:

- Requires Phase 0 decisions
- Streams A/B/C can run in parallel after interface agreement

Exit criteria:

- Unit tests pass for daemon bootstrap and web API URL resolution
- No behavior regressions in existing daemon/web dev flow

## Phase 2: ElectroBun Desktop App Scaffold (2-4 days)

Outcomes:

- New desktop app package exists and runs locally.
- Desktop starts daemon, loads bundled web assets, and shuts down cleanly.

Deliverables:

- `apps/desktop` with:
  - `electrobun.config.ts`
  - Bun entrypoint
  - BrowserWindow bootstrap
  - build hooks for web build and asset copy
- Root scripts:
  - `desktop:dev`
  - `desktop:build:canary`
  - `desktop:build:stable`

Parallel work streams:

- Stream A (Agent: Desktop Runtime, file ownership: `apps/desktop/src/bun/*`)
- Stream B (Agent: Desktop Build Config, file ownership: `apps/desktop/electrobun.config.ts`, `apps/desktop/scripts/*`)
- Stream C (Agent: Monorepo Scripts, file ownership: root `package.json`, `README.md` docs index)

Dependencies:

- Phase 1 daemon and web runtime config complete
- Stream C can start in parallel once script names are agreed

Exit criteria:

- `desktop:dev` launches desktop UI successfully
- Desktop UI can call daemon API end-to-end
- Clean shutdown works (no orphan daemon process)

## Phase 3: CLI Distribution Path (2-3 days)

Outcomes:

- CLI method can run daemon + webapp without desktop shell.

Deliverables:

- New CLI package (`apps/cli` or `packages/cli`) with commands:
  - `burns start`
  - `burns daemon`
  - `burns web` (if separated)
- Packaging for distribution (npm/bun package strategy)

Parallel work streams:

- Stream A (Agent: CLI Runtime, file ownership: `apps/cli/src/*`)
- Stream B (Agent: Web Packaging for CLI, file ownership: `apps/web` build integration + CLI static serving layer)
- Stream C (Agent: DX/Docs, file ownership: CLI README + usage docs)

Dependencies:

- Phase 1 runtime config contract complete
- Can proceed in parallel with late Phase 2 hardening

Exit criteria:

- CLI starts daemon and serves/opens webapp successfully
- CLI install + run workflow documented and reproducible

## Phase 4: Release Automation and Artifact Publishing (2-4 days)

Outcomes:

- Canary/stable release pipelines for desktop and CLI.

Deliverables:

- CI matrix jobs by OS/arch for desktop artifacts
- Artifact upload flow for ElectroBun release host
- CLI publish/release workflow
- Release notes/changelog automation updates

Parallel work streams:

- Stream A (Agent: CI Pipeline, file ownership: `.github/workflows/*`)
- Stream B (Agent: Artifact Publishing, file ownership: release scripts + ElectroBun hook scripts)
- Stream C (Agent: Release Docs, file ownership: `docs/*`, `CHANGELOG.md`)

Dependencies:

- Desktop and CLI local builds validated first

Exit criteria:

- One successful canary pipeline producing downloadable artifacts
- Stable pipeline dry-run validated

## Phase 5: Hardening, Testing, and Rollout (2-3 days)

Outcomes:

- Distribution paths are reliable and observable.

Deliverables:

- Smoke tests for:
  - desktop startup + daemon connectivity
  - CLI startup + daemon connectivity
  - artifact integrity checks
- rollback guidance and known-issues table
- final rollout checklist

Parallel work streams:

- Stream A (Agent: Test Automation, file ownership: `apps/*/test*`, `scripts/smoke-*`)
- Stream B (Agent: Reliability, file ownership: health checks, startup diagnostics)
- Stream C (Agent: Documentation, file ownership: rollout runbook)

Exit criteria:

- Smoke suite green on release matrix
- Rollout checklist signed off

## Cross-Phase Parallelization Map

## Workstream 1: Daemon Runtime Ownership

Responsibilities:

- bootstrap/start-stop lifecycle
- graceful shutdown and signal handling
- API health readiness used by desktop/CLI

Recommended agent profile: backend worker

## Workstream 2: Web Runtime and Packaging Ownership

Responsibilities:

- runtime API URL resolution
- packaged-web compatibility (`views://` and CLI static path)
- UI startup diagnostics for bad API config

Recommended agent profile: frontend/platform worker

## Workstream 3: Desktop Shell Ownership

Responsibilities:

- ElectroBun entrypoint/window lifecycle
- daemon orchestration from desktop shell
- desktop build hooks and artifact shape

Recommended agent profile: desktop/runtime worker

## Workstream 4: CLI Productization Ownership

Responsibilities:

- CLI command UX
- daemon/web startup orchestration
- package/release metadata

Recommended agent profile: tooling/runtime worker

## Workstream 5: Release Engineering Ownership

Responsibilities:

- CI matrix builds
- artifact upload/publish
- canary/stable gating rules

Recommended agent profile: DevOps/release worker

## Workstream 6: QA and Docs Ownership

Responsibilities:

- smoke/e2e checks
- release/runbook docs
- rollback and support notes

Recommended agent profile: QA/docs worker

## Suggested Agent Assignment Template

Use this exact split to avoid conflicts:

- Agent 1: `apps/desktop/**`
- Agent 2: `apps/daemon/src/{main.ts,server/**,config/**}`
- Agent 3: `apps/web/src/lib/api/**`, `apps/web/src/app/**`
- Agent 4: `apps/cli/**`
- Agent 5: `.github/workflows/**`, `scripts/release/**`
- Agent 6: `docs/**`, `README.md`, `CHANGELOG.md`

Coordination rule:

- Only one agent owns a write scope at a time.
- Shared contract changes must land first (`packages/shared/**`) before downstream consumers.

## Risks and Mitigations

1. Risk: daemon startup semantics differ between dev and packaged runtime.
- Mitigation: single bootstrap module used by dev, desktop, and CLI.

2. Risk: webapp API URL mismatch in packaged environments.
- Mitigation: explicit runtime config precedence and startup validation log.

3. Risk: desktop shutdown leaves daemon orphaned.
- Mitigation: before-quit hook + process group cleanup + smoke tests.

4. Risk: release artifact drift across OS/arch.
- Mitigation: unified naming contract and CI artifact verification step.

5. Risk: cross-platform assumptions drift from real ElectroBun behavior.
- Mitigation: gate on CI matrix output, treat host-only local builds as expected.

## Definition of Done

All conditions must be true:

- Desktop method: packaged app launches daemon and webapp, and artifacts publish for canary/stable.
- CLI method: installable CLI launches daemon and webapp reliably.
- Shared runtime API URL contract works across dev/desktop/CLI.
- Smoke tests pass in CI for supported platforms.
- Documentation updated for build, release, and rollback procedures.
