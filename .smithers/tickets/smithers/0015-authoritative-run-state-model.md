# Authoritative Run-State Model

> Target repo: **smithers** (`codeplaneapp/smithers`)
> Source: memo §1, §2 · roadmap Phase 0

## Problem

Run status in Smithers today is inferred unevenly across surfaces: the TUI
checks SQLite plus `ps`, the dashboard infers from event absence, and users
routinely see `idle` for runs that are alive, hung, or orphaned. The field
report's top complaint — "why is smithers dead?" — is a direct consequence
of there being no single authoritative state.

## Goal

A single, typed run-state model, computed server-side from persisted state
plus liveness signals, consumed unchanged by every UI (CLI, TUI, GUI, JJHub
web UI, Gateway RPC).

## Scope

### 1. State enum

```ts
type RunState =
  | "running"           // owner alive, work progressing
  | "waiting-approval"  // blocked on a human decision
  | "waiting-event"     // blocked on an external signal
  | "waiting-timer"     // blocked on a scheduled wakeup
  | "recovering"        // supervisor replaying / resuming
  | "stale"             // owner heartbeat expired, not yet recovered
  | "orphaned"          // owner gone, no supervisor candidate
  | "failed"
  | "cancelled"
  | "succeeded"
  | "unknown"           // telemetry gap; prefer over a false "idle"
```

Never emit `idle`. Prefer `unknown` when a signal is missing.

### 2. ReasonBlocked / ReasonUnhealthy

For every non-terminal state, attach a typed reason:

```ts
type ReasonBlocked =
  | { kind: "approval"; nodeId: string; requestedAt: string }
  | { kind: "event";    nodeId: string; correlationKey: string }
  | { kind: "timer";    nodeId: string; wakeAt: string }
  | { kind: "provider"; nodeId: string; code: "rate-limit" | "auth" | "timeout" }
  | { kind: "tool";     nodeId: string; toolName: string; code: string }

type ReasonUnhealthy =
  | { kind: "engine-heartbeat-stale"; lastHeartbeatAt: string }
  | { kind: "ui-heartbeat-stale"; lastSeenAt: string }
  | { kind: "db-lock" }
  | { kind: "sandbox-unreachable" }
  | { kind: "supervisor-backoff"; attempt: number; nextAt: string }
```

### 3. Computation

A single `computeRunState(runId): Promise<RunStateView>` in
`packages/core` (or wherever run queries currently live). Pure over DB +
heartbeat table + lease table — no `ps`, no heuristics. Every other surface
calls this. Direct SQL status reads in UI code are removed.

### 4. Wire format

`RunStateView` goes into:
- `smithers inspect <runId>` output
- Gateway RPC `getRun`
- DevTools snapshot header (field on `DevToolsSnapshot`)
- event stream (`RunStateChanged` event with before/after)

## Files

- `packages/core/src/runState/` (new): enum, reasons, `computeRunState`
- `packages/core/src/index.ts` — export
- `packages/gateway/src/rpc/getRun.ts` — return `RunStateView`
- `packages/devtools/src/snapshot.ts` — embed in header
- `apps/cli/src/inspect.ts` — render
- remove ad hoc status inference in `apps/tui`, `apps/cli`, dashboard

## Testing

- Unit: state transitions from every non-terminal state to every terminal
  state given fixture DB + heartbeat rows.
- Unit: missing heartbeat → `unknown` (not `idle`, not `succeeded`).
- Unit: expired lease but DB `in_progress=true` → `stale`.
- Unit: lease absent, owner gone → `orphaned`.
- Contract: snapshot JSON shape stable (golden file).
- Integration: one fixture run, verify CLI / Gateway / DevTools snapshot
  return byte-identical state strings.

## Acceptance

- [ ] No surface emits `idle`.
- [ ] `computeRunState` is the only status source.
- [ ] `ReasonBlocked` / `ReasonUnhealthy` populated for every non-terminal,
      non-running state.
- [ ] Golden contract test passes across CLI + Gateway + DevTools.

## Blocks

- 0016 (heartbeats feed this)
- 0017 (lease feeds this)
- 0018 (recovery transitions publish `RunStateChanged`)
- gui/0001, jjhub/0003 (inspector UIs consume it)
