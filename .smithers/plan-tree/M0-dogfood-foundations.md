---
id: plan/m0
title: "M0: Dogfood & Foundations"
parent: "[[INDEX]]"
milestone: M0
status: in_progress
updated: 2026-11-25
children:
  - "plan/m0/fleet-readiness"
  - "plan/m0/tiered-backpressure-workflows"
  - "plan/m0/plan-tree-ui"
  - "plan/m0/private-smithers-ops"
  - "plan/m0/core-contracts-and-gates"
---

# M0: Dogfood & Foundations

Goal: Establish fleet health, incremental `fast-check`/`medium-check`/`full-check` Smithers workflows, visible Obsidian-compatible Plan Tree dogfooding, private `Smithers-Ops` hosting (`roninjin10`-only), and settle Gates 1-4 with Will before writing core foundation code.

## Assumptions

- [x] `smithers.sh` and `smithers.sh/evmts/voltaire` are live (HTTP/2 200 verified 2026-11-24).
- [x] `Williams-Mac-mini.local` (199 GiB free), `nyc-02` (214 GiB RAM avail), and `cfbox` are reachable.
- [ ] `nyc-01` SSH hang resolved and `nyc-02` disk (33 GiB free) + MacBook Pro disk (2.4 GiB free) reclaimed safely without disturbing live fuzz lanes.
- [ ] `codex-6` re-authenticated and expiring Claude sign-ins renewed before Nov 26.
- [x] Gate 1 (Sync Engine) Approved by Will 2026-11-24.
- [x] Gate 2 (Multi-Client Core + `.smithers/` Plugins) Approved by Will 2026-11-24.
- [x] Gate 3 (Progressive-Disclosure UX) Approved by Will 2026-11-24.
- [x] Gate 4 (BYOA-Only MCP + Jev) Approved by Will 2026-11-24.

## Leaves

### `plan/m0/fleet-readiness`
- **Status:** `in_progress` (audit complete, disk/SSH/login items surfaced to Will)
- **Model Tier:** `sol-40` + coordinator
- **Host:** `macbook-coord` / `nyc-02` / `mac-mini`
- **DoD (`fast-check`):** `limits.py --paid-only --refresh --recommend` exits `0`, `cfbox list` exits `0`, target compute hosts report `>= 50 GiB` free disk and healthy SSH.

### `plan/m0/core-contracts-and-gates`
- **Status:** `done` (all 4 gates approved 2026-11-24, recorded as decisions 0170 to 0173)
- **Gates:** Gate 1 (Sync Engine), Gate 2 (Multi-Client Core + `.smithers/` Plugins + Security Table), Gate 3 (Progressive-Disclosure UX), Gate 4 (BYOA-Only MCP + `incur` + Jev + Browser-Agent Removal)
- **Contract File:** the Wave 1 draft `contracts/core-contracts.ts`
- **Model Tier:** `panel-10` (Neon + Fable 5.2 + Astra 6.2 + Opus 5.5 + Sol 6.2)
- **DoD (`fast-check`):** All 4 visual HTML review packages delivered with rejected alternatives and empirical POC receipts.

### `plan/m0/tiered-backpressure-workflows`
- **Status:** `in_progress` (`fast-check` exists at `.smithers/workflows/fast-check.ts` and runs with plain Node. `medium-check` and `full-check` are not written. The durable `.vibe` form waits for the Gate 2 `workflows/` reader)
- **Scope:** Author `.smithers/workflows/fast-check.vibe`, `medium-check.vibe`, and `full-check.vibe` using `smthrs affected` + cached targets, runnable locally, on `nyc-02`, and sharded on `cfbox`.
- **Model Tier:** `opus-30`
- **Host:** `nyc-02` + `cfbox`
- **DoD (`medium-check`):** `smthrs flow start fast-check --wait` completes in `< 30s` on a single-file edit with cache hits on untouched packages (`rc=0`).

### `plan/m0/plan-tree-ui`
- **Status:** `in_progress` (PlanTree shard, UI component, Workbench Effect store, and live `/$owner/$repo/workbench` route landed on `main` in `f771206c`. Live deploy & E2E verification pending)
- **Scope:** Obsidian-compatible Plan Tree parser (`@smthrs/plan-tree`), live viewer/editor pane in `@smthrs/ui` (Gemini Neon), bidirectional links to artifacts and code-mode trace nodes.
- **Model Tier:** `neon-ui` (UI/copy) + `opus-30` (parser/schema)
- **Host:** `mac-mini` / `cloudflare-alchemy`
- **DoD (`medium-check`):** Live Plan Tree renders on `smithers.sh`, edits round-trip cleanly to Obsidian `.md` frontmatter + `[[wikilinks]]`, verified via MCP + SDK + Playwright E2E.

### `plan/m0/private-smithers-ops`
- **Status:** `pending` (unblocked: Gates 1 and 2 approved 2026-11-24)
- **Scope:** Host `~/Smithers-Ops` as a private workspace on `smithers.sh` gated strictly to `roninjin10` (`DEPLOYMENT_ADMIN_LOGINS` + per-workspace private ACL + zero public metadata leakage + private artifact upload visibility).
- **Model Tier:** `fable-20` (ACL/security) + `astra` security review
- **Host:** `cloudflare-alchemy`
- **DoD (`medium-check`):** Authenticated `roninjin10` reads/views Plan Tree & artifacts. Unauthenticated and non-owner requests receive `404`/`403` with zero slug/title/artifact leak (`rc=0`).
