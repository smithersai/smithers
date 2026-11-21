# Core Packages & CI Follow-Ups (CORE-17)

This proposal records the small set of `packages/*` and root-CI follow-ups surfaced while preparing `apps/mvp` and companion `apps/*` for release. None of these block the current `apps/mvp` web release, and all live outside `apps/*` so they belong to the core packages and Smithers CI maintainers.

## 1. `@smthrs/triggers` Cloudflare Worker / Durable Object Host (`#4607`)

- **Need:** `apps/mvp` currently uses durable timers inside `FlowExecution` Durable Objects for scheduled work (such as spend alert windows and role rechecks). Exposing a first-party Cloudflare Worker / Durable Object trigger adapter in `@smthrs/triggers` will let repository-defined cron and webhook triggers run on the same portable contract as Node/Bun.
- **Suggested contract:** An Effect `Layer` translating trigger schedules onto Durable Object alarms (single alarm multiplex per repository object) with idempotent execution keys matching `FlowStarter`.

## 2. `@smthrs/platform-browser` Engine Prepare Hardening (`#4981`)

- **Need:** In `packages/smithers/flows/platform-browser/src/internal/Prepare.ts`, transient IndexedDB/OPFS lock contention on cold browser boot should surface structured retryable errors rather than failing the tab engine preparation outright.
- **Impact on `apps/mvp`:** Eliminates rare cold-tab `ENGINE_FAILED` states during rapid multi-tab reloads.

## 3. Published `@smthrs/cli` Type Declaration Hygiene

- **Observation:** `apps/site/scripts/regressions/published-cli-types.test.mjs` flags a `.d.ts` type mismatch coming from published `@smthrs/cli@1.0.0-rc.16` (via `incur@0.7.1`).
- **Action:** Re-verify exported `.d.ts` bundles on the next `@smthrs/cli` release candidate so `apps/site`'s `check:docs` regression suite passes end-to-end.

## 4. Root CI & `PACKAGE.ts` Registration (`#5450`)

- **Need:** Wire `apps/mvp` typecheck, lint (`--max-warnings=0`), unit/deploy tests, and `apps/site` doc checks into root `PACKAGE.ts` and `.github/workflows/ci.yml` once the Smithers CI pipeline rollout completes.
