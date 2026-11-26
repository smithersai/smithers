# Smithers Cloud Public Release Plan Tree

Live production build on `https://smithers.sh`: `f97d8fa14875` (Quiet Launch deployed via Alchemy, 17/17 live canary checks passed, 5/5 Chromium and WebKit Playwright deploy-smoke runs passed).
Latest pushed `origin/main` revision: `e477666aedec` (47 verified commits landed since `85aa0fc1f416`).

## Milestone Status

| Milestone | Status | Verified Receipts |
| --- | --- | --- |
| Wave 1 and 4 Architecture Gates | Done | ADRs 0170, 0171, 0172, 0173, and 0174 committed on `main` |
| M1 One Core, Four Clients | Done | `@smthrs/app-core` + `smthrs node serve` stdio MCP + 4-client local SQLite E2E (`LocalNodeFourClient.test.ts` 4/4) + `.smithers/workflows/gate.vibe` discovery |
| M1 Local-First SQLite Shards (ADR 0170) | In Progress (Slices 1-4a Done) | Slice 3 `MessagesShard` + `MessagesShardObject` live in prod (Codex Astra `APPROVE_TO_LAND`, 100% V8, 0 `worker/request-owned-io` errors across all workers), Slice 4a browser `MessagesShardClient` + `JournalCollection` landed (`5df62b88`), Slice 4b app-state + Lean metadata running on Claude Fable |
| M1 Thin GUI and Progressive Disclosure | Done | `WorkbenchScreen`, `WaitlistScreen`, 3-tier `PaneFrame`, URL-owned layout, shortcuts `1`-`7` / `[` / `]` / `0` / `Esc`, Command Palette, conversation restoration, compact clamping, `PlaygroundFrame` (100% V8, zero `useState`/`useEffect`, Gemini 4 Neon) |
| M2 First-Party Factories and Playgrounds | Done | Sandboxed `PlaygroundFrame` (`sandbox="allow-scripts"`, Codex Astra `APPROVE_TO_LAND` bridge) live on `tevm-monorepo`, `zevm`, `vibelang`, and `smithers` (all 200 live), plus isolated `cfbox` `.smithers/` inventory verified for all 7 `smithersai/` example forks |
| M2 VibeLang Worker Migration | In Progress (94 `.vibe` Modules) | `domains/*`, `secrets/*`, `personal/*`, `stack/*`, `profile/*` 100% migrated, `runners/*` and `mcp/*` wrapping up with 100% V8 coverage on every migrated module |
| M3 Formal Verification and Fuzzing | Done | Lean 4.32.0 + 4.36.0 installed on Mac mini, 22/22 Lean packages `lake build` exit 0 (0 `sorry`, 0 `axiom`, 0 `admit`), 20/20 real Lean-oracle `lean-diff` suites pass (323/323 executed), 7 MVP fuzz suites x 4 seeds deterministic pass |
| M3 Security, Hygiene, and Startup Budget | Done | `BundleHygiene.test.ts` 6/6 pass on `apps/mvp/dist`, `bench/startup.ts` 50.2 ms median vs 200 ms budget, zero `worker/request-owned-io` errors across all worker modules |
| M3 Quiet Launch Production Deploy and Canary | Done | Live on `https://smithers.sh` (`f97d8fa14875`), 17/17 live canary pass (`maxRedirects: 0`), 5/5 Chromium + WebKit `ops/deploy-smoke/run.ts` pass, `@smthrs/notifications` Telegram failure alerting wired (`2bd64862`, 100% V8) |

## Active Parallel Lanes

1. `W6-SYNC-SLICE4B` (Claude Fable): Extend `@smthrs/app-state` chat state machine and Lean 4 proofs with full message metadata for Slice 5 Electric cutover.
2. `W6-VIBE-22` (Codex Sol `codex-2`): Migrate `mcp/{Auth,LiveDeps}` and `plan/{PlanTreeRoutes,PlanTreeShard}` to `.vibe`.
3. `W6-VIBE-23` (Codex Sol `codex-5`): Complete `runners/{RunContent,TranscriptHost}` and start `ci/{Cron,Dispatch}` in `.vibe`.
4. `M3-MEDIUM-CHECK-AND-NODESERVE` (Claude Opus): Full tier-2 `medium-check.ts` verification across `worker`, `src`, `db`, fuzz, and Lean.

## Latest Progress Receipt

- **Live Quiet Launch (`https://smithers.sh`):** deployed revision `f97d8fa14875`, 17/17 live canary PASS, 5/5 Playwright deploy-smoke PASS (Chromium + WebKit).
- **ADR 0170 Sync Engine (Slices 1 through 4c landed on `main` at `7220a2b9`):** Codex Astra `APPROVE_TO_LAND` on Slices 3, 4b, and 4c, Lean 4.36.0 clean (24 jobs, 0 `sorry`/`admit`/`axiom`), 500-trace real Lean oracle byte-identical across 37,001 operations, 100% V8 coverage, whole-app `apps/mvp` ESLint 0 errors / 0 warnings. Slice 5a (full message parity + browser `ChatStore` read adapter) in progress.
- **VibeLang Worker Migration:** 164 `.vibe` worker modules landed on `main` (100% V8 coverage on every migrated file, 100% of `domains/*`, `secrets/*`, `personal/*`, `stack/*`, `profile/*`, `plan/*`, `runners/*`, `ci/*`, `mcp/*`, and `flows/*` migrated, final 5 files of `branch/*` in flight).
