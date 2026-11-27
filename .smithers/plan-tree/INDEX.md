# Smithers Cloud Public Release Plan Tree

Live production build on `https://smithers.sh`: `5444ec67b209` (deployed via Alchemy with zero deletes or replacements, migration `135_message_note_versions` applied, live canary passed, and 5/5 Chromium and WebKit Playwright deploy-smoke runs passed).
Latest pushed `origin/main` revision: `5444ec67b209` (147 verified commits landed since `85aa0fc1f416`).

## Milestone Status

| Milestone | Status | Verified Receipts |
| --- | --- | --- |
| Wave 1 and 4 Architecture Gates | Done | ADRs 0170, 0171, 0172, 0173, and 0174 committed on `main` |
| M1 One Core, Four Clients | Done | `@smthrs/app-core`, `smthrs node serve` stdio MCP, 4-client local SQLite E2E (`LocalNodeFourClient.test.ts` 4/4), and `.smithers/workflows/gate.vibe` discovery |
| M1 Local-First SQLite Shards (ADR 0170) | In Progress (Slices 1-5a Live in Prod) | Slice 5a (`53eefc386b48`) live on `https://smithers.sh` with Codex Astra `APPROVE_TO_LAND` (0 P0, 0 P1, 0 P2), 913/913 MVP tests, 79/79 Electric tests, 100% V8 on all 11 core and ported modules, wait-free 2-key route denial, exclusive Web Locks, and clean `200 { allowed: false }` conversation access probes (`5444ec67b209`). Slice 5b (default `MessagesShard` cutover for branch and home plus lazy idempotent Postgres backfill) running now. |
| M1 Thin GUI and Progressive Disclosure | Done | `WorkbenchScreen`, `WaitlistScreen`, 3-tier `PaneFrame`, URL-owned layout, shortcuts `1`-`7` / `[` / `]` / `0` / `Esc`, Command Palette, conversation restoration, compact clamping, and `PlaygroundFrame` (100% V8, zero `useState`/`useEffect`, Gemini 4 Neon) |
| M2 First-Party Factories and Playgrounds | Done | Sandboxed `PlaygroundFrame` (`sandbox="allow-scripts"`, Codex Astra `APPROVE_TO_LAND` bridge) live on `tevm-monorepo`, `zevm`, `vibelang`, and `smithers` (all 200 live), plus isolated `cfbox` `.smithers/` inventory verified for all 7 `smithersai/` example forks |
| M2 VibeLang Migration (`apps/mvp`) | 487 `.vibe` Modules (100% Non-Sync Done) | 242 worker `.vibe` modules + 245 src `.vibe` modules landed on `main` (100/100/100/100 V8 on every migrated module, zero mocks, whole-app `lint --max-warnings=0` exit 0, `worker/attach/LiveMount.vibe`, `src/features/auth/*`, and `src/device/identity.vibe` all Codex Astra `APPROVE_TO_LAND`). Remaining ~15 sync/chat files migrate alongside ADR 0170 Slice 5b/6. |
| M3 Formal Verification and Fuzzing | Done | Lean 4.32.0 + 4.36.0 installed on Mac mini, 22/22 Lean packages `lake build` exit 0 (0 `sorry`, 0 `axiom`, 0 `admit`), 20/20 real Lean-oracle `lean-diff` suites pass, 500-trace real Lean oracle byte-identical across 37,001 operations, Tier-2 `medium-check.ts` exit 0 (8,985/8,985 integration + 181 bounded fuzz) |
| M3 Security, Hygiene, and Startup Budget | Done | `BundleHygiene.test.ts` 6/6 pass on `apps/mvp/dist`, `bench/startup.ts` 50.2 ms median vs 200 ms budget, legacy attach route rate-limit P1 unified (`664f27cb84af`, Codex Astra `APPROVE_TO_LAND`), zero `worker/request-owned-io` errors |
| M3 Production Deploy and Canary | Live & Verified (`5444ec67b209`) | Live on `https://smithers.sh`, migration `135_message_note_versions` applied, live canary pass (`maxRedirects: 0`), 5/5 Chromium + WebKit `ops/deploy-smoke/run.ts` pass, `@smthrs/notifications` Telegram failure alerting wired |

## Active Parallel Lanes

1. `W6-SYNC-SLICE5B` (Claude Opus, `~/w5/sync`): Cut over `ChatStore` (both branch and home conversations) to `MessagesShard` by default with lazy idempotent Postgres backfill (`MessagesShardBackfill.vibe`) and remove the Electric chat read fallback. Queued for Codex Astra review upon completion.
2. `W6-SYNC-SLICE6` (Queued next): Move remaining operational shapes off Electric, delete `ElectricGateway` and the Electric container, migrate final ~15 sync/chat `.ts` files to `.vibe`, run Tier-3 `full-check`, and deploy final release candidate to `https://smithers.sh`.

## Latest Progress Receipt

- **Live Production (`https://smithers.sh`):** deployed revision `5444ec67b209`, live canary PASS, 5/5 Playwright deploy-smoke PASS (3/3 Chromium + 2/2 WebKit with zero undeclared console errors).
- **ADR 0170 Slice 5a:** landed at `53eefc386b48` (`VERDICT: APPROVE_TO_LAND`, 0 P0 / 0 P1 / 0 P2), followed by `200 { allowed: false }` access probe polish at `5444ec67b209`.
- **VibeLang Migration:** 487 `.vibe` modules across `apps/mvp` (242 worker + 245 src), 100% of all non-sync Effect modules migrated with 100/100/100/100 V8 coverage and zero mocks.
