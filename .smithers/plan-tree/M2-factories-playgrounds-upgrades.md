---
id: plan/m2
title: "M2: Factories, Playgrounds & Upgrades"
parent: "[[INDEX]]"
milestone: M2
status: in_progress
updated: 2026-11-25
blocked_by:
  - "plan/m1"
children:
  - "plan/m2/tevm-universe-factories"
  - "plan/m2/smithers-universe-factories"
  - "plan/m2/third-party-example-forks"
  - "plan/m2/live-blockchain-playgrounds"
  - "plan/m2/t3code-and-vibestack-ux-upgrades"
  - "plan/m2/openprose-structured-markdown-eval"
  - "plan/m2/vibelang-incremental-migration"
---

# M2: Factories, Playgrounds & Upgrades

Goal: Prove the `.smithers/` plugin seams on real production repositories across the Tevm universe, Smithers universe, and `smithersai/` example forks, ship interactive live-blockchain playgrounds, apply systematic t3code + VibeStack UX upgrades, evaluate OpenProse, and finish the incremental VibeLang (`.vibe`) migration of `apps/mvp`.

## Leaves

### `plan/m2/tevm-universe-factories`
- **Repos:** `guillotine`, `guillotine-mini`, `zevm`, `tevm`, `voltaire`, `voltaire-effect` (VibeLang), `tevm-effect` (VibeLang)
- **Deliverables per repo (tailored via `.smithers/`, never copy-paste):** Hyper-optimized CI/CD runnable anywhere, custom repo-aware `.vibe` workflows, Obsidian-compatible wiki generation, mythical history, tailored GitHub-class UI.
- **Model Tier:** `opus-30` (workflows/CI) + `neon-ui` (tailored repo homes/UI) + `sol-40` (wiki/test verification)
- **Host:** `nyc-02` + `cfbox`
- **DoD (`medium-check`):** Every repo loads live on `smithers.sh`, CI workflow runs green locally and on `cfbox`, wiki + mythical history render cleanly.

### `plan/m2/live-blockchain-playgrounds`
- **Repos:** `tevm`, `zevm`
- **Scope:** Sandboxed iframe + narrow workflow bridge interactive live-blockchain playgrounds (EVM execution, fork state inspection, trace stepping) reusable as pluggable playground templates.
- **Model Tier:** `neon-ui` (UI) + `fable-20` (sandbox bridge & state execution)
- **Host:** `cloudflare-alchemy` + `cfbox`
- **DoD (`medium-check`):** Interactive EVM tx execution and trace inspection pass Playwright E2E + sandbox CSP isolation test (`rc=0`).

### `plan/m2/smithers-universe-factories`
- **Repos:** `vibelang` / `vibe` (full VIP/approval process + custom domain `vibelang.sh`), `smithers` (full dogfood), `smithers-ci`, `claude-p`, `zmux`
- **Model Tier:** `fable-20` + `opus-30` + `neon-ui`
- **Host:** `nyc-02` + `mac-mini` + `cloudflare-alchemy`
- **DoD (`medium-check`):** All 5 repos operate live on `smithers.sh`, VibeLang VIP approval flow verified E2E, `smithers` dogfoods its own CI & Plan Tree.

### `plan/m2/third-party-example-forks`
- **Repos under `smithersai/` org (clearly badged as `smithersai/` forks, not official upstream):** `Effect-TS/effect`, `alchemy`, `foldkit`, `t3code`, `opencode`, `needlefish` (refcell / "spearfish"), and `eliza`
- **HARD SECURITY RULE FOR `eliza`:** Strictly inside an isolated Cloudflare Sandbox (`cfbox` / CF Container) with ZERO host secrets, ZERO shared cache namespaces, and ZERO files ever cloned/installed/run on MacBook, Mac mini, `nyc-01`, or `nyc-02`.
- **Model Tier:** `opus-30` + `sol-40` + `neon-ui` (fork badge & tailored repo homes)
- **Host:** `cfbox` (mandatory for `eliza`, burst for others)
- **DoD (`medium-check`):** Every fork renders live with prominent `smithersai/` fork badge. Zero `eliza` paths exist on any local/bare-metal host.

### `plan/m2/t3code-and-vibestack-ux-upgrades`
- **Scope:** Dedicated side-by-side audit of `t3code` (local/fork) and Shaw's VibeStack (web research / CF Sandbox ONLY, never local Eliza) feeding concrete UX/IA upgrades into `@smthrs/ui` implemented exclusively by Gemini Neon.
- **Model Tier:** `fable-20` (architecture diff) + `neon-ui` (100% UI implementation)
- **Host:** `cfbox` + `mac-mini`
- **DoD (`medium-check`):** Before/after Playwright GIFs verified by Will in review queue.

### `plan/m2/openprose-structured-markdown-eval`
- **Scope:** Evaluate OpenProse structured markdown patterns for `.md`/`.mdx` workflows in VibeLang (`vibe`) and write a crisp adopt/adapt/reject decision record.
- **Model Tier:** `fable-20` + `opus-30`
- **Host:** `macbook-coord` / `nyc-02`
- **DoD (`fast-check`):** Decision record + runnable `.md`/`.mdx` workflow compilation test (`rc=0`).

### `plan/m2/vibelang-incremental-migration`
- **Scope:** Migrate ALL Effect code in `apps/mvp` incrementally to idiomatic `.vibe` in parallel, constantly-merged slices. Enforce type-level API + JSDoc identity and full tooling coverage (lint, format, typecheck, CI, Alchemy Worker bundles via `deferred("rolldown")`). Obey VibeLang traps (`try (X |> f(%))`, `if` instead of `try match` in 0.0.13, no `--fix`).
- **Model Tier:** `opus-30` + `sol-40` (per-module slices) + `fable-20` (compiler/tooling fixes in `../effectscript` if hit)
- **Host:** `nyc-02` + `cfbox`
- **DoD (`medium-check`):** 0 Effect `.ts` files left in `apps/mvp`, declaration identity gate passes, Alchemy production bundle compiles cleanly (`rc=0`).
