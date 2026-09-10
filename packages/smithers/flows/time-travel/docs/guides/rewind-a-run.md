---
title: "Rewind a run to a frame"
description: "Truncate a run back to an earlier frame: the state the run must be in, the detached-child policy, what the result and the audit row tell you, and every way the operation refuses."
sidebar:
  order: 3
---

A rewind removes everything a run recorded after a frame, compensating the side
effects it crosses on the way. It is the one destructive operation in this
package, and the only one that takes the run away from whoever is driving it.

## Park the run first

A rewind is a writer. It claims the run's ownership like any driver and refuses
a run that is still executing, so the run must be idle: pending or suspended.

The usual way to get there is a durable wait. A flow parked at a
`DurableDeferred.await` has released ownership with its history committed,
which is exactly the state a rewind requires:

```ts
yield * Ledger.execute({}, { executionId: "ledger-1", discard: true })
```

## Rewind

```ts
import { FlowEngine } from "@smthrs/engine"
import { TimeTravel } from "@smthrs/time-travel"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const timeTravel = yield* TimeTravel
  return yield* timeTravel.rewind({
    runId: "ledger-1",
    frame: { lineageId: FlowEngine.Lineage.root("ledger-1"), seq: 4 }
  })
})
```

The ownership claim, the audit id, the heartbeat, and the compensation-handler
registry are all wired inside the service. None of them is a parameter.

The result is the accounting:

| Field               | What it holds                                                      |
| ------------------- | ------------------------------------------------------------------ |
| `auditId`           | The audit row this rewind wrote. Read it back for the full detail. |
| `frame`             | The frame the run was truncated to.                                |
| `archive.archived`  | How many journal records were moved into the archive.              |
| `archive.orphaned`  | The lineage edges left pointing at history that no longer exists.  |
| `assessments`       | Every crossed effect and the verdict it was given.                 |
| `warnings`          | Terminal detached children that survive the truncation.            |
| `cancelledChildren` | The children the policy cancelled, in the order they landed.       |

Records are archived, not deleted: they move aside so a forensic reader can
still reach them. Archive rows are keyed by `(run_id, generation, seq)`, using
the journal generation before truncation advances it. Reused sequences retain
each discarded history. Snapshot anchors above the frame and all anchors of
archived attached children are removed in the same transaction.

After the truncation the run is suspended carrying the state
derived at the frame, not the state its truncated future had left on the row.
Deferred completions and clock deadlines whose journal records moved into the
archive are removed atomically with that truncation. If the resumed run reaches
the same deferred or timer again, it waits again instead of consuming the
discarded future's value or deadline.

## Choose what happens to detached children

`RewindOptions.detachedChildren` is the one policy decision the caller makes:

```ts
yield * timeTravel.rewind(position, { detachedChildren: "cancel" })
```

- `"block"`, the default: a live detached child refuses the rewind rather than
  being cancelled behind the operator's back.
- `"cancel"`: the rewind cancels idle (`pending` or `suspended`) detached
  children and running detached children whose owner lease has expired, after
  the commit point, and lists them in `cancelledChildren`. A running child
  whose owner is still live refuses with `live_child`. `Options.isAlive` may
  veto cancellation even after the lease expires.

An **attached** child is not covered by this option at all. It still depends on
the history being truncated, so a live one always refuses the rewind with
`live_child`. Detach it or let it finish first.

The value is decoded before anything durable happens. A misspelled
`"blcok"` is refused `invalid` rather than falling through to the destructive
branch.

## Bound the read

`pageSize` sets the journal page size for the suffix scan. `maxHistoryEntries`
caps the suffix the rewind may truncate for this one call, and a longer suffix
is refused `limit_exceeded` **before** the run is claimed, so an oversized
rewind never takes the run away from anyone.

## Read the audit row back

The audit row is the durable record of the attempt, and it outlives the call:

```ts
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

const audited = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  return yield* sql<{ readonly status: string }>`
    SELECT status FROM flows_time_travel_audits WHERE id = ${result.auditId}
  `
})
```

`status` is `in_progress`, `completed`, or `failed`. Its `detail` column
carries the phase the protocol reached, the suffix it measured, the target
pointer, the compensation receipts, the warnings, and the children it cancelled
or still owes a cancellation.

A runnable version of this walkthrough is
[`06-time-travel-rewind.ts`](https://github.com/smithersai/smithers/blob/main/examples/src/06-time-travel-rewind.ts)
in the Smithers examples on GitHub.

## Failures

| Code                  | Cause                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `busy`                | Another owner holds the run, the journal tail moved under the claim, or ownership was lost before the end.           |
| `live_child`          | An attached descendant is still executing, or a detached child is blocked by policy or owner liveness.               |
| `not_found`           | The run, the frame, or the audit addresses nothing.                                                                  |
| `invalid`             | A malformed option, or a durable payload that does not decode. Refused before anything is touched.                   |
| `rate_limited`        | The `Options.rateLimit` limiter the service was built with rejected the attempt. The audit row records the decision. |
| `irreversible`        | A crossed effect cannot be undone: no handler, or a sealed result whose cache entry is gone.                         |
| `compensation_failed` | A rollback handler or the workspace restore failed, so the rewind stopped rather than half revert.                   |
| `fence_lost`          | Ownership of the run or of an attached child was superseded before the commit, so nothing was written.               |
| `limit_exceeded`      | The suffix is longer than the cap allows. Raised before the run is claimed.                                          |
| `unknown`             | The store, the journal, or an unmapped host failure. The cause is attached.                                          |

If a rewind fails after claiming the run but before commit, successful rollback
restores the saved run state and releases ownership as `suspended`, including
when the run was originally
`pending`. Startup recovery uses the same restoration rule. The audit closes
as `failed` after restoration succeeds. If ownership cannot be released, the
audit stays `in_progress` for recovery; the error keeps its original code and
attaches the restoration problem as its cause. See
[The rewind protocol](../concepts/rewind-protocol.md) for where each step sits
relative to that point, and what a crash between them costs.

## Where to go next

- [The rewind protocol](../concepts/rewind-protocol.md): the ordered protocol
  and its crash behaviour.
- [Compensate an irreversible effect](./compensate-an-effect.md): turning an
  `irreversible` refusal into a rewind that succeeds.
- [Troubleshooting](../troubleshooting.md): each refusal, and what to change.
