# Tickets

Existing flat tickets (`0009-0014`) are Smithers-repo DevTools/CLI work.
Tickets from the 2026-04-16 hardening memo are organized by target repo:

## `smithers/` — this repo (`codeplaneapp/smithers`)

Phase 0 — operator trust, recovery, CLI:

- [0015](smithers/0015-authoritative-run-state-model.md) — Authoritative run-state model (no more `idle`)
- [0016](smithers/0016-dual-heartbeats.md) — Engine + UI heartbeats
- [0017](smithers/0017-run-lease-owner-epoch.md) — Run lease + owner epoch (single owner, fenced writes)
- [0018](smithers/0018-recovery-state-machine.md) — Typed recovery transitions + supervisor policy
- [0019](smithers/0019-side-effect-idempotency-metadata.md) — Tool side-effect / idempotency metadata
- [0020](smithers/0020-cli-why-doctor-repair.md) — `smithers why` / `doctor run` / `repair` + prefix IDs + `--json`
- [0021](smithers/0021-docs-as-contracts.md) — Docs maturity labels + CI smoke tests
- [0022](smithers/0022-fault-injection-e2e-matrix.md) — E2E fault-injection matrix
- [0023](smithers/0023-gateway-reference-deployment.md) — Gateway stable RPC + reference deployment

## `jjhub/` — `/Users/williamcory/jjhub`

Make JJHub the blessed Smithers runtime:

- [0001](jjhub/0001-runtime-capability-contract.md) — Runtime capability contract
- [0002](jjhub/0002-implement-runtime-on-workspaces.md) — Implement runtime on JJHub workspaces
- [0003](jjhub/0003-web-ui-inspector-backend.md) — Web UI Smithers inspector surface
- [0004](jjhub/0004-smithers-on-jjhub-reference.md) — Reference architecture + example

## `gui/` — `/Users/williamcory/gui` (Swift macOS app)

- [0001](gui/0001-consume-devtools-snapshot.md) — Consume DevToolsSnapshot / delta stream
- [0002](gui/0002-reconnect-cursor-ghost-state.md) — Reconnect-from-cursor + ghost state

## Dependency order (abridged)

```
smithers/0015 ─┬─ 0016 ─┐
               ├─ 0017 ─┼─ 0018 ─┬─ 0020 ─ 0022
               │        │        └─ 0023 ─ jjhub/0003 ─ gui/0001 ─ gui/0002
               └─ 0019 ─┘                              ↘
                                              jjhub/0001 ─ jjhub/0002 ─ jjhub/0004
```

Phase 0 (weeks 1–4): smithers/0015–0021.
Phase 1 (weeks 5–12): smithers/0022–0023, jjhub/0001–0002, gui/0001.
Phase 2 (weeks 13+): jjhub/0003–0004, gui/0002.

## Out of scope (for now)

- **`codeplane`**: surveyed (`/Users/williamcory/codeplane`) — parallel
  project with its own `cli/server/tui/codeplanectl` apps. Not treated
  as a Smithers runtime consumer in this round; revisit if codeplane
  adopts the Gateway contract.
- Core engine (DAG, reconciler, JSX, SQLite) — explicitly preserved per
  memo "What I would not change."
