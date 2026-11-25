---
id: plan/m1
title: "M1: Core Node, Plugins & UX"
parent: "[[INDEX]]"
milestone: M1
status: pending
gates_approved: 2026-11-24
updated: 2026-11-24
blocked_by:
  - "plan/m0/core-contracts-and-gates"
children:
  - "plan/m1/sync-engine-and-reference-fsm"
  - "plan/m1/multi-client-core-and-harness"
  - "plan/m1/self-hosted-node-swarm"
  - "plan/m1/byoa-mcp-and-browser-agent-removal"
  - "plan/m1/minimal-plugin-seams-and-security"
  - "plan/m1/progressive-disclosure-ui-overhaul"
  - "plan/m1/n8n-flow-canvas-and-linked-trace"
  - "plan/m1/wiki-and-mythical-history-ui"
  - "plan/m1/state-machine-viewer-and-lean-gen"
  - "plan/m1/waitlist-whitelist-and-notifications"
---

# M1: Core Node, Plugins & UX

Goal: Build the Gate 1-4 foundations (approved by Will 2026-11-24, decisions 0170 to 0173) in parallel against the Wave 1 draft `contracts/core-contracts.ts`, join end-to-end on real repos (`voltaire`, `smithers`, `vibelang`) in Hour 1, and ship the complete progressive-disclosure UI over `@smthrs/ui`.

## Parallel Execution Tracks (Broken Upfront by Contract)

### Track A: Event-Sourced Sync & Formally Verified State Machine (`plan/m1/sync-engine-and-reference-fsm`)
- **Model Tier:** `fable-20` (implementation) + `panel-10` (Lean 4 proofs) + `sol-40` (fuzz harness)
- **Host:** `nyc-02` + `cfbox`
- **Scope:**
  - Pure reference state machine decoupled from sync transport (`@smthrs/app-state`), verified in Lean 4 (monotonic seq, idempotency, convergence, authorization invariants).
  - Approved Gate 1 sync engine (DO SQLite `{ storage: ctx.storage }` + local SQLite + TanStack DB collection adapter) replacing fragile Electric single-container restarts.
  - Zero-debt removal of superseded sync code once migration completes.
- **DoD (`medium-check`):** 100% coverage on state reducer, Lean 4 proof builds with `0` sorries, 10,000-trace fuzz convergence green, multi-device offline E2E passes.

### Track B: Multi-Client Core & 4-Client Parity Harness (`plan/m1/multi-client-core-and-harness`)
- **Model Tier:** `fable-20` (core) + `opus-30` (4 adapters) + `sol-40` (parity test suite)
- **Host:** `nyc-02` / `mac-mini`
- **Scope:**
  - Single `@smthrs/app-core` library exposing (1) Pure MCP server, (2) `incur` Skill/CLI (`packages/smithers/src/Cli.ts`), (3) VibeLang/TS/JS SDK, (4) Ultra-thin React adapter.
  - Headless 4-client verification harness proving every GUI workflow executes identically via MCP, Skill, and SDK against the Lean reference state machine.
- **DoD (`medium-check`):** Every core workflow has a 4-client parity test passing headlessly without a browser (`rc=0`).

### Track C: Self-Hosted Local-First Node Swarm (`plan/m1/self-hosted-node-swarm`)
- **Model Tier:** `fable-20` + `opus-30`
- **Host:** `mac-mini`, `nyc-02`, `nyc-01`, `cloudflare-alchemy`
- **Scope:**
  - Self-hosted node daemon (`smthrs node serve` via `incur`) running on laptop, Mac mini, `nyc-01`/`nyc-02`, and GitHub Actions.
  - Local-first operation + eventual sync up to `smithers.sh` + GitHub two-way reconciliation (GitHub writes only on explicit person publish).
  - Baseline workload scheduler targeting Will's hardware with overflow burst to `cfbox` (up to 500 sandboxes).
- **DoD (`medium-check`):** Live Mac mini and `nyc-02` nodes execute workflows offline, reconnect, and converge cleanly with `smithers.sh` (`rc=0`).

### Track D: BYOA-Only MCP, Jev UX & Browser-Agent Removal (`plan/m1/byoa-mcp-and-browser-agent-removal`)
- **Model Tier:** `opus-30` (removal/refactor) + `fable-20` (attenuated MCP auth & Jev) + `neon-ui` (copy-prompt attach UI & Jev config UI)
- **Host:** `nyc-02` + `cloudflare-alchemy`
- **Scope:**
  - Cleanly delete built-in browser agent (`src/features/agent/*`, `chat/Answer`, dead routes/tables) with zero tech debt.
  - One-click copy-prompt BYOA MCP attach for Claude Code, Codex, Antigravity, Cursor (pure MCP, no fallback transport).
  - Jev configuration UI + maintainer-owned workflow execution policy (typed failure at every enumerable seam, never silent LLM fallback).
- **Slice 1 (landed in Wave 2 Track E):** in-memory attach intent, consent, grant and revocation (`apps/mvp/worker/attach/Attach.ts`), the `/mcp` Streamable HTTP handler (`McpRoute.ts`), and the exhaustive `Jev.config` validator (`apps/mvp/src/features/jev/config.ts`). Not yet durable, routed or wired to the registry.
- **DoD (`medium-check`):** Zero browser-agent imports remain, live Claude Code + Codex MCP attach executes workflows and renders panes in `smithers.sh`, Jev typed-failure tests pass.

### Track E: Minimal `.smithers/` File-Based Plugin Seams & Security Layers (`plan/m1/minimal-plugin-seams-and-security`)
- **Model Tier:** `fable-20` + `astra`+`fable` security audit
- **Host:** `nyc-02` + `cloudflare-alchemy`
- **Scope:**
  - Complete Decision 0017 plugin seams under `.smithers/` (`workflows/*.vibe`, `plugins/*/plugin.json`, `home.json`, `wiki/`, `plan-tree/`, `playgrounds/`).
  - Enforce QuickJS primitive-string-only boundary, sandboxed iframe + narrow workflow bridge, container sandboxes + iron-proxy secrets egress, attenuated credentials, host-owned action strip, and session-end device wipe.
  - Deletion test in CI verifying core boots cleanly with `plugins: []`.
- **DoD (`medium-check`):** Astra + Fable root-input-tracing table verified against code, QuickJS getter-trap regression test passes, plugin deletion test passes (`rc=0`).

### Track F: Complete Progressive-Disclosure UI Overhaul (`plan/m1/progressive-disclosure-ui-overhaul` .. `waitlist-whitelist-and-notifications`)
- **Model Tier:** `neon-ui` (100% of user-facing UI, layout, copy, docs, waitlist, errors) + `opus-30` (backend data feeds)
- **Host:** `mac-mini` / `cloudflare-alchemy`
- **Scope (all strictly on `@smthrs/ui`, end-user-driven: splash -> visual docs -> tests/API -> impl):**
  1. Chat-with-panes shell with maximize-external-to-chat and 3-tier progressive disclosure (dead-simple default -> inspector drawers -> full power workbench).
  2. n8n-grade visual workflow canvas + durability/replay/time-travel inspector.
  3. Code-mode linked-trace debugger (click any artifact/output -> jump to causal Plan Tree/prompt node).
  4. Obsidian-compatible Wiki reader/editor & Mythical History navigator.
  5. Visual State Machine viewer + Lean proof generation/status pane.
  6. Interactive sandbox terminal (`@smthrs/terminal-frame`) + GitHub-class PR/issue/review/branch UI.
  7. High-desire non-maintainer waitlist/whitelist flow + audience role switcher + Telegram/email notifications (`@smthrs/notifications`).
- **DoD (`medium-check`):** Zero semicolons/em dashes in public copy, zero `useState`/`useEffect` violations, Playwright E2E + GIF check (`pnpm e2e:gifs:check`) green across light & dark modes.
