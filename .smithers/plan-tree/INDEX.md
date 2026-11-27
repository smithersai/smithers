# Smithers Cloud Public Release Plan Tree

Live production build on `https://smithers.sh`: `ba3b18c352ad` (deployed via Alchemy with zero deletes or replacements, migrations `0136`–`0139` applied, `17/17` live canary checks passed, `GET /api/health` returning `200`, and live Chromium E2E passed on `/`, `/smithersai/smithers`, and `/docs/` with zero page or 5xx errors).

## Milestone Status

| Milestone | Status | Verified Receipts |
| --- | --- | --- |
| Wave 1 and 4 Architecture Gates | Done | ADRs 0170, 0171, 0172, 0173, and 0174 committed on `main` |
| M1 One Core, Four Clients | Done | `@smthrs/app-core` promoted as published package #54, `smthrs node serve` stdio MCP, 4-client local SQLite E2E (`LocalNodeFourClient.test.ts` 4/4), and `.smithers/workflows/gate.vibe` discovery |
| M1 Local-First SQLite Shards (ADR 0170) | In Progress (Slices 1–5b Live in Prod; Slice 6a Landed) | Slice 5b (`915f87c8e4af`) landed and deployed live on `https://smithers.sh` (default `MessagesShard` cutover for branch and home conversations, lazy idempotent Postgres backfill, migration `0139_messages_shard_pending`, Codex Astra P1 #1–#9 + Claude Fable P1 & P2 #2 fixes, `94/94` real Postgres+SQLite+workerd tests, `MessagesShard.ts` 100/100/100/100 V8). Slice 6a landed: pure LWW `Pins` reducer in `@smthrs/app-state` (`100/100/100/100` V8) + person-private `worker/pins/PinsShard.vibe` DO SQLite shard (`100/100/100/100` V8 + real Miniflare workerd DO SQLite verified, all Claude Fable P0/P1/P2 findings fixed). |
| M1 Thin GUI and Progressive Disclosure | Done | `WorkbenchScreen`, `WaitlistScreen`, 3-tier `PaneFrame`, URL-owned layout, shortcuts `1`–`7` / `[` / `]` / `0` / `Esc`, Command Palette, conversation restoration, compact clamping, `PlaygroundFrame`, and aligned `smithers.sh` + `smithers-ci` public front door (`dab224d510f8`) |
| M2 First-Party Factories and Playgrounds | Done | Sandboxed `PlaygroundFrame` live on `tevm-monorepo`, `zevm`, `vibelang`, and `smithers` (all 200 live), plus isolated `cfbox` `.smithers/` inventory verified for all 7 `smithersai/` example forks |
| M2 VibeLang Migration (`apps/mvp`) | 491+ `.vibe` Modules | `W6-VIBE-SRC-52` (`07fc32b7`, conversations, status/store, plugins) and `worker/pins/PinsShard.vibe` landed on `main` (100/100/100/100 V8, zero mocks, whole-app `lint --max-warnings=0` exit 0). |
| M3 Formal Verification and Fuzzing | Done | Lean 4.32.0 + 4.36.0 installed on Mac mini, 22/22 Lean packages `lake build` exit 0 (0 `sorry`, 0 `axiom`, 0 `admit`), 20/20 real Lean-oracle `lean-diff` suites pass, 500-trace real Lean oracle byte-identical across 37,001 operations, Tier-2 `medium-check.ts` exit 0 |
| M3 Security, Hygiene, and Startup Budget | Done | `BundleHygiene.test.ts` 6/6 pass, `bench/startup.ts` 50.2 ms median vs 200 ms budget, `trackedHygiene` 0 findings, `lint:jsdoc` 0 errors, `Confine.vibe` temp-HOME `npx` jail fix, zero `worker/request-owned-io` errors |
| M3 Production Deploy, Release, and Canary | Live & Verified (`ba3b18c352ad`) | Live on `https://smithers.sh`, migrations `0136`–`0139` applied, `17/17` live canary PASS (`maxRedirects: 0`), `GET /api/health` 200, live Chromium E2E PASS, `smithers-ci` + `@smthrs/app-core` npm release pipeline unblocked (`v1.0.0-rc.21`) |

## Active Parallel Lanes

1. `W6-SYNC-SLICE6B`: Wire `PinsShardObject` + `PinsShardRoutes` + dual-write backfill bridge to cut `src/features/pins/store.vibe` off Electric, then migrate remaining operational shapes off Electric and delete `ElectricGateway` and the Electric container.
2. `W6-RELEASE-NPM`: Publish `v1.0.0-rc.21` (54 packages including `smithers-ci` and `@smthrs/app-core`) to npm with all pack/smoke gates green.

## Latest Progress Receipt

- **Live Production (`https://smithers.sh`):** deployed revision `ba3b18c352ad`, `17/17` live canary PASS, `GET /api/health` 200, live Chromium E2E PASS on `/`, `/smithersai/smithers`, and `/docs/` with zero page or 5xx errors.
- **ADR 0170 Slice 5b + Slice 6a:** Slice 5b landed (`915f87c8e4af`) and deployed to production; Slice 6a (`@smthrs/app-state` `Pins` + `apps/mvp/worker/pins/PinsShard.vibe`) landed with 100/100/100/100 V8 coverage and real Miniflare workerd DO SQLite verification after resolving all Claude Fable P0/P1/P2 findings.
- **Release & Drift Hygiene:** Promoted `@smthrs/app-core` (#54), fixed all 147 JSDoc errors, fixed `flow/Archive.ts` release version-stamp normalization in `check-api-baseline.mjs`, fixed `Confine.vibe` temp-HOME `npx` jail mount + `tarball.e2e.mjs` cache-token expression, and turned `Drift` 9/9 green.
