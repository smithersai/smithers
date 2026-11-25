---
id: plan/m3
title: "M3: Release Gate"
parent: "[[INDEX]]"
milestone: M3
status: pending
updated: 2026-11-24
blocked_by:
  - "plan/m2"
children:
  - "plan/m3/zero-bug-burndown-and-full-check"
  - "plan/m3/security-by-construction-signoff"
  - "plan/m3/fuzzing-formal-proofs-and-benchmarks"
  - "plan/m3/production-canaries-observability-alerts"
  - "plan/m3/docs-reconciliation-and-live-e2e-dogfood"
---

# M3: Release Gate

Goal: Clear every release-readiness bar across quiet Smithers Cloud launch and next-week loud launch with zero bugs, full observability, formal proofs, fuzzing, benchmarks, canaries, and live E2E dev across all target repos.

## Leaves

### `plan/m3/zero-bug-burndown-and-full-check`
- **Model Tier:** `sol-40` + `opus-30` + `fable-20` + `neon-ui` (UI bugs)
- **Host:** Sharded across `cfbox` + `nyc-02` + `mac-mini`
- **DoD (`full-check`):** Zero open P0/P1/P2 bugs. `smthrs flow start full-check --wait` exits `0` across MCP, Skill/CLI, SDK, GUI, Worker, and self-hosted node suites. `pnpm e2e:gifs:check` passes with zero blank/frozen/flashing frames.

### `plan/m3/security-by-construction-signoff`
- **Model Tier:** `panel-10` (Codex Astra + Claude Fable mandatory root-input-tracing review)
- **Host:** `nyc-02` + `cfbox`
- **Scope:** Full root-input-tracing table across auth, sessions, BYOA MCP tokens, QuickJS realm (`@smthrs/views`), sandboxed iframe bridge, container sandboxes, iron-proxy secrets egress, private `Smithers-Ops` ACL, waitlist/whitelist gating, and zero `jjhub` strings in public bundles/copy.
- **DoD (`full-check`):** Zero unresolved High/Critical findings. Every security invariant backed by automated negative tests (`rc=0`).

### `plan/m3/fuzzing-formal-proofs-and-benchmarks`
- **Model Tier:** `sol-40` (arbitrary fuzz campaigns) + `fable-20` (Lean 4 proofs & perf)
- **Host:** `nyc-02` + `cfbox` + `mac-mini` (never wall-time benchmark on `nyc-02` due to `cpu-slices.sh`)
- **Scope:**
  - Deep arbitrary fuzzing campaign (`arbitrary-fuzzing.smithers.sh` methodology) covering state machine, sync convergence, plugin manifest decoder, QuickJS boundary, MCP JSON-RPC, and VibeLang workflows. Retain all minimized counterexamples.
  - Lean 4 proofs compiled with zero `sorry` for local state machine, sync protocol, and durable workflow execution invariants.
  - Local + live production benchmarks (boot time, input-to-row p95 `< 50ms`, OPFS restore p95 `< 150ms`, sync delta latency, Worker startup budget) with published method, artifacts, and limitations.
- **DoD (`full-check`):** Zero unfixed fuzz crashes, Lean 4 builds clean (`rc=0`), benchmark receipts committed and within budgets.

### `plan/m3/production-canaries-observability-alerts`
- **Model Tier:** `fable-20` + `opus-30`
- **Host:** `cloudflare-alchemy` + `nyc-02` + `mac-mini`
- **Scope:** Continuous production canary suite (read + scratch-repo write + MCP attach + sync convergence + SPA deep-link `maxRedirects: 0` check), full OTLP logs/traces/metrics across front end, Workers, and fleet inference/compute monitors, wired to Telegram alerts via `@smthrs/notifications` `Channels.layer`.
- **DoD (`full-check`):** Canaries green continuously for 24h prior to loud launch. Alert delivery tested end-to-end with zero secrets/payloads in logs.

### `plan/m3/docs-reconciliation-and-live-e2e-dogfood`
- **Model Tier:** `neon-ui` (public docs, splash, onboarding, diagrams) + `opus-30` (`.specs/` & `Smithers-Ops` stale doc reconciliation)
- **Host:** `cloudflare-alchemy` + `mac-mini`
- **Scope:** Reconcile remaining stale docs in `.specs/` and `~/Smithers-Ops`. Verify live E2E dev workflow (open repo -> attach BYOA MCP agent -> inspect Plan Tree -> run sandbox terminal -> review diff/trace -> publish PR -> merge by person) across Will's repos on `smithers.sh`.
- **DoD (`full-check`):** Live E2E dogfood receipts + GIFs across all first-party repos. Zero stale contradictions. Will's final launch sign-off.
