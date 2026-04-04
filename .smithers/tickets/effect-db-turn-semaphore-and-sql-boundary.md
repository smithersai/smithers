# Replace promise-tail DB turn coordination with Effect concurrency primitives

## Problem

`SmithersDb` currently serializes SQLite access with a hand-rolled promise tail:

- `src/db/adapter.ts:67` stores `transactionTail: Promise<void>`
- `src/db/adapter.ts:211-224` builds a pending `gate` promise in
  `acquireTransactionTurnEffect()`
- `src/db/adapter.ts:253` acquires the turn before entering transaction work

This is fragile under interruption. If a fiber is interrupted after publishing a new
`transactionTail` but before it releases its gate, later DB work can wait forever on
an unresolved promise. That is exactly the kind of lifecycle bug Effect is meant to
avoid.

The current approach also means DB coordination is happening outside the standard
Effect resource/concurrency model, so cancellation, fairness, and cleanup are all
manual.

## Proposal

Replace the promise-tail lock with Effect-native concurrency control.

### Preferred direction

Use one of:

- `Effect.Semaphore` for a single-writer permit
- `Queue` / `Deferred` if explicit FIFO turn-taking is still required
- `Scope`/`ensuring` so permit release is interruption-safe by construction

### Stretch direction

Audit whether the adapter should move more of its write coordination onto
`@effect/sql` transaction primitives instead of continuing to manage SQLite locking
manually.

## Implementation

1. Introduce an adapter-local concurrency primitive backed by Effect, not promises.
2. Acquire/release writer access with `acquireRelease` or equivalent so interruption
   cannot leak the lock.
3. Keep `BEGIN IMMEDIATE` transaction scope tight and separate from any non-DB work.
4. Preserve the existing nested-transaction guard unless savepoints are intentionally
   added.
5. Remove `transactionTail` and `acquireTransactionTurnEffect()` once the new path is
   in place.

## Additional Steps

1. Review all call sites of `readEffect`, `writeEffect`, and `withTransactionEffect`.
2. Decide whether reads should share the same serialized writer gate or whether only
   writes/transactions need exclusivity.
3. If fairness matters, document the chosen behavior explicitly.
4. Add logging around permit acquisition latency so contention is visible.

## Verification requirements

### Concurrency and interruption

1. Interrupt a fiber while it is waiting for the DB turn; the next queued operation
   must still proceed.
2. Interrupt a fiber while it owns the permit; the permit must be released
   automatically.
3. Run many concurrent writes and assert there is no deadlock or leaked permit.
4. Run many concurrent reads around a write transaction and assert the adapter still
   behaves deterministically.

### Regression coverage

5. Add a focused test for the old failure mode: publish turn ownership, interrupt the
   waiter, then verify a later write does not hang.
6. Preserve the existing nested transaction failure behavior unless savepoints are
   explicitly supported.

## Observability

### Metrics

- `smithers.db.turn_wait_ms` - histogram for time spent waiting on the DB permit
- `smithers.db.turn_contention_total` - counter for queued acquisitions

### Logging

- `Effect.withLogSpan("db:turn")`
- Annotate with `{ operation, writeGroup, queued }`

## Codebase context

- `src/db/adapter.ts:67`
- `src/db/adapter.ts:119-188`
- `src/db/adapter.ts:211-224`
- `src/db/adapter.ts:227-320`

## Effect.ts architecture

This work should eliminate manual promise-based coordination from an internal module.
The adapter is not an API boundary, so it should stay entirely in Effect.

Use Effect concurrency/resource primitives rather than `Promise` chains for lock
ownership and cleanup.
