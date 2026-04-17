# Dual Heartbeats: Engine + UI

> Target repo: **smithers**
> Source: memo §1, §4 · roadmap Phase 0

## Problem

"Is smithers alive?" has two answers today, and the system tracks neither
cleanly:

1. **Engine liveness** — is the owning process still ticking the run?
2. **UI liveness** — is an operator attached; have they seen recent state?

Absent both, the TUI shows `idle`, dashboards lie, and users build stale-run
reaper scripts.

## Goal

Two independent heartbeat streams persisted and exposed on `RunStateView`.

## Scope

### Engine heartbeat

- Emitted by the run owner (reconciler loop) every `ENGINE_HEARTBEAT_MS`
  (default 2000ms, configurable).
- Row: `(runId, ownerEpoch, at, payload)` in a `run_heartbeats` table
  (single row per run, upserted).
- `payload`: `{ lastEventSeq, lastNodeId, activeToolCall?, tokensLastMin,
  stdoutBytesLastMin, filesChangedLastMin }`.
- Freshness SLO: `stale` after `3 × ENGINE_HEARTBEAT_MS`, `orphaned` after
  `6 × ENGINE_HEARTBEAT_MS` with no lease holder alive.

### UI heartbeat

- Any subscriber of the DevTools stream posts an ack every 5s with
  `{ subscriberId, lastSeqSeen, attachedSince }`.
- Stored in `ui_heartbeats` keyed by `subscriberId`.
- Surfaced on `RunStateView.viewers: Viewer[]` so operators know who else is
  watching and whether any human-facing UI is caught up.

### Consumers

- `RunStateView` gains `engineHeartbeat` and `viewers` fields.
- `smithers why` uses heartbeat freshness for the first line of output.
- Gateway `streamRunEvents` heartbeats are separate from business events
  (a `Heartbeat` frame every 1s even when no events), so reconnects can
  distinguish "quiet" from "disconnected".

## Files

- `packages/db/migrations/0012_heartbeats.sql`
- `packages/core/src/heartbeat/engineHeartbeat.ts`
- `packages/core/src/heartbeat/uiHeartbeat.ts`
- `packages/react-reconciler/src/reconciler/index.ts` — call engine beat
- `packages/gateway/src/rpc/streamRunEvents.ts` — separate heartbeat frame
- `packages/core/src/runState/computeRunState.ts` — read both

## Testing

- Unit: heartbeat age → state mapping at the SLO thresholds (2s, 6s, 12s).
- Integration: kill reconciler; run becomes `stale` within one SLO window,
  `orphaned` within two.
- Integration: subscriber dies; its viewer row ages out without affecting
  engine state.
- Soak: 30-min attached UI, verify no DB growth beyond expected upserts.
- Fault: clock skew ±30s on owner → does not flip state wrongly (use
  server-assigned timestamps only).

## Acceptance

- [ ] Two heartbeat tables, separate SLOs, documented.
- [ ] `RunStateView` exposes both.
- [ ] Gateway emits protocol-level heartbeat frames distinct from events.
- [ ] `smithers why` cites heartbeat age in its first output line.
- [ ] No surface uses `ps` or command-name matching for liveness.

## Blocks

- 0015 (stale/orphaned transitions depend on this)
- 0020 (`smithers why`)
