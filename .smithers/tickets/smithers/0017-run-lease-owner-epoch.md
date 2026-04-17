# Run Lease and Owner Epoch

> Target repo: **smithers**
> Source: memo §2 · roadmap Phase 0

## Problem

A Smithers run today can be picked up by more than one process (supervisor
resume + manual resume, two workers racing after a restart). There is no
authoritative record of "who owns this run right now", so tool calls and
DB writes can duplicate, and recovery is informal.

## Goal

Every run has at most one active owner at any instant, enforced by a
persisted lease; every state-mutating write checks the caller's epoch.

## Scope

### Lease table

```
run_leases(
  runId        TEXT PRIMARY KEY,
  ownerId      TEXT NOT NULL,      -- process/worker identity
  epoch        INTEGER NOT NULL,   -- monotonically increasing per run
  acquiredAt   TEXT NOT NULL,
  expiresAt    TEXT NOT NULL,      -- acquiredAt + leaseTtl
  releasedAt   TEXT
)
```

### Operations

- `acquireLease(runId, ownerId, ttlMs): { epoch }` — fails with
  `LeaseHeld` if a non-expired lease exists for another owner.
- `renewLease(runId, ownerId, epoch): void` — called at each engine
  heartbeat; fails with `EpochMismatch` if superseded.
- `releaseLease(runId, ownerId, epoch): void` — best-effort on clean exit.
- `takeoverLease(runId, newOwnerId, reason): { oldEpoch, newEpoch }` —
  only callable by the supervisor after the current lease is past
  `expiresAt`. Writes an audit row.

### Fencing

Every DB write that mutates run state (`writeEvent`, `commitFrame`,
`writeNodeOutput`, `writeNodeDiff`, approval decisions) takes `{ runId,
epoch }` and rejects writes where `epoch < current.epoch`. This is the
teeth behind the lease — the lease alone doesn't stop stale workers
without fencing at the write path.

### Ownership states

Lease computation feeds `RunStateView`:
- `owner: "alive" | "stale" | "lost" | "superseded"`
- `ownerId`, `epoch`, `acquiredAt`, `expiresAt`

## Files

- `packages/db/migrations/0013_run_leases.sql`
- `packages/core/src/lease/` (new) — `acquire`, `renew`, `release`,
  `takeover`, typed errors
- `packages/db/src/SqlMessageStorage.js` — fence write methods on epoch
- `packages/react-reconciler/src/reconciler/index.ts` — acquire on start,
  renew in heartbeat loop, release on stop
- `packages/scheduler/src/supervisor.ts` — takeover path

## Testing

- Unit: two concurrent `acquireLease` calls → one wins, one gets
  `LeaseHeld` with the current owner.
- Unit: renewing with the wrong epoch → `EpochMismatch`.
- Integration: kill owner, wait past TTL, supervisor takes over, old owner
  resurrects briefly and tries to write → write rejected with
  `EpochMismatch`; no duplicate event in the log.
- Integration: two supervisors race on takeover → one wins, the other sees
  the new epoch and backs off.
- Fault: clock skew — TTL uses server time only; workers don't self-judge
  expiry.
- Soak: 1000 acquire/release cycles, no row growth beyond one per run.

## Acceptance

- [ ] Every run-mutating write path is fenced on `epoch`.
- [ ] Supervisor takeover is audited (before/after owner, reason).
- [ ] `RunStateView.owner` reflects lease state.
- [ ] Stale-task reset scripts become unnecessary — the supervisor
      handles takeover deterministically.

## Blocks

- 0018 (recovery state machine builds on lease)
- 0015 (`owner` field in `RunStateView`)
