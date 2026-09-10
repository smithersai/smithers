---
title: "The claim protocol"
description: "How hosts coordinate at-least-once launch attempts: revision fencing, launch reservations and their lease, the outcomes a result records, and the two watermarks that decide what is due."
sidebar:
  order: 3
---

Run two hosts against one database and both will notice the 03:00 boundary. The
claim protocol coordinates their launch reservations. It does not guarantee a
single call to the runner for that occurrence.

Scheduled dispatch makes at-least-once launch attempts. `RunnerService.start`
must durably deduplicate by `idempotencyKey` and return the same run identity on
replay, including across host restarts.

Claim decisions live in the store transaction, so they read current state
rather than a scheduler snapshot that may have gone stale. Runner deduplication
covers accepted launches outside that transaction.

## The store is asked for candidates, not for due work

`TriggerStore.list` returns every trigger, and nothing more. Due-ness is a cron
computation the scheduler performs against its own watermark, so there is no
due-time query to keep in sync with the policy logic, and no index whose
staleness could hide a trigger. A tick reads every row rather than only the
enabled ones because a trigger disabled while a run was active still has to
recover that occurrence; the enabled check then stops its new claims.

## A claim is fenced on a revision

`claimFire` carries the occurrence and the revision the occurrence was computed
from:

```ts
import * as TriggerStore from "@smthrs/triggers/TriggerStore"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"

const claimOne = (
  store: TriggerStore.Service,
  trigger: TriggerStore.Registered,
  occurrence: number
) =>
  Effect.gen(function*() {
    const claim = yield* store.claimFire({
      triggerId: trigger.id,
      occurrence,
      expectedRevision: trigger.revision
    })
    if (!claim.claimed) return Option.none()
    if (claim.action === "fire" || claim.action === "supersede") {
      return Option.some(claim.reservationId)
    }
    yield* store.recordResult({
      triggerId: trigger.id,
      occurrence,
      outcome: claim.action === "skip" ? "skipped" : "buffered"
    })
    return Option.none()
  })
```

Note what the request does not carry: an overlap policy, a flow id, or an
input. The transaction reads `enabled`, `revision`, and `overlap` from the
trigger row itself, so a caller holding a snapshot from before an edit cannot
fire a trigger that has since been disabled, cannot point it at a different
flow, and cannot supersede a run the stored declaration says to leave alone.

Three refusals come out of that read, and each names one thing to do:

| Failure             | Meaning                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `unknown_trigger`   | No such row. Claim, result, pending-state and active-run methods report this; `get` answers `None` and `register` creates the row. |
| `trigger_disabled`  | The row exists and `enabled` is false.                                                                                             |
| `revision_mismatch` | Somebody re-registered the trigger. Re-read the row and decide again.                                                              |

The scheduler answers `revision_mismatch` by re-reading the row once and
deciding again from it. The occurrences it was claiming were computed from the
old declaration, so it does not retry them: it recomputes what is due from the
refreshed cron, timezone, and watermark, and a trigger edited to fire at noon
owes nothing for the hourly boundary its old cron produced. A buffered
occurrence is store state rather than a computed decision, so its resumption is
retried as is. One refresh is enough, because the next tick reads again anyway.

## A claim that wins hands back work, or a decision

`Claim` has three shapes, and they are separate on purpose:

```ts
type Claim =
  | { readonly claimed: false }
  | { readonly claimed: true; readonly action: "skip" | "buffer" }
  | {
    readonly claimed: true
    readonly action: "fire" | "supersede"
    readonly reservationId: string
    readonly activeRunId?: string | undefined
  }
```

`claimed: false` means another worker holds this occurrence. A claim that only
records a decision names no reservation, because none was written; a claim that
hands you work to launch always names the reservation it wrote against the
trigger row, so you always have an id to release. There is no shape in which
you can read a reservation id that does not exist.

A `supersede` claim also names `activeRunId`, the run it displaced, so the
caller has something to cancel.

## The reservation and its lease

Between winning a claim and having a run id, a host holds a **reservation**: a
placeholder written into the trigger's active-run column, spelled
`trigger-reservation:<triggerId>:<attempt>:<occurrence>`. Each attempt gets a
fresh UUID, including a retry of the same occurrence. Keep the token returned
by the claim; the two-argument helper below constructs legacy ids.

```ts
import * as TriggerStore from "@smthrs/triggers/TriggerStore"

TriggerStore.reservationId("nightly-report", 3_600_000)
// "trigger-reservation:nightly-report:3600000"
TriggerStore.isReservation("run-42") // false
TriggerStore.reservationOccurrence("trigger-reservation:nightly-report:3600000")
// 3600000
```

A reservation is not a run. The runner has never heard of it, so asking whether
it is active answers "no" for a launch that is still in flight. Only its lease
may release it. `TriggerStore.reservationLeaseMs` is 300,000 milliseconds, or 5
minutes, and both store implementations use the same constant so swapping the
in-memory store for the SQL one cannot change recovery timing.

When the lease expires, the store reclaims the reservation and restores its
unfinished occurrence to pending work, whether the expiry is noticed during an
active-run read or during a later claim. That is the recovery path for a process
that died after claiming an occurrence. A launch may already have been accepted
before its `launched` result is persisted. A crash or result-write failure in
that window leaves the occurrence retryable. Lease expiry can also allow another
attempt while an earlier runner call is still in flight. The stable idempotency
key, not the reservation token, identifies the run across those attempts. Under
`supersede`, the reservation also retains the predecessor run id, so recovery
re-attaches to that run and cancels it before launching the replacement rather
than leaving two runs alive.

## Results close the loop

`recordResult` reports how one occurrence ended:

| Outcome      | Written when                                                          |
| ------------ | --------------------------------------------------------------------- |
| `launched`   | The runner returned a run id. The reservation is replaced by that id. |
| `completed`  | The run stopped and the host observed it stop.                        |
| `failed`     | The launch or the run failed. The message is kept on the fire row.    |
| `skipped`    | The overlap policy dropped the occurrence.                            |
| `buffered`   | The overlap policy remembered the occurrence.                         |
| `superseded` | A newer occurrence replaced this one.                                 |

A launched result must include a non-empty `runId` and the `reservationId`
returned by its claim:

```ts
const result: TriggerStore.Result = {
  triggerId: "nightly-report",
  occurrence: 3_600_000,
  outcome: "launched",
  runId: "run-42",
  reservationId: "trigger-reservation:nightly-report:attempt-uuid:3600000"
}
```

The transaction checks the active token and the fire state (`null` or
`buffered`) before changing either row. A stale token or terminal fire fails
with `stale_owner` and leaves the ledger, cursor, and active owner unchanged.
The scheduler logs the refusal and cancels the losing accepted run unless an
idempotent retry has adopted it. A missing,
empty, or whitespace-only run id fails with `invalid_options` at `runId`.

A terminal result clears the active run only when it names the run recorded
for its occurrence. Terminal callers may omit `runId` to settle that recorded
run. Before launch, pass `reservationId` to fence a failure to the exact claim
attempt. Repeated decisions and settlements do not rewrite a fire. A supersede
claim settles the displaced reservation inside its claim transaction.

## Buffered compensation is atomic

`claimPending` consumes the pending pointer when it reserves buffered work.
If dispatch fails, `restorePending({ triggerId, occurrence, reservationId })`
restores the pointer and releases only that matching unfinished reservation in
one transaction. It coalesces with newer pending work. A failed write retains
the lease, so a process crash still leaves a recovery path. The scheduler logs
compensation failures.

If cancellation of a predecessor fails, the same operation restores the
predecessor only while its fire is still launched and queues the replacement
atomically. Stale compensation fails with `stale_owner` and cannot release a
newer reservation.

## Two watermarks, and why both exist

**`lastFiredAt` is durable and only moves forward.** It is the cursor catch-up
resumes from. A completed skip or buffer advances it inside the claim
transaction; a fire or supersede does not advance it until the launched run id
is durable. Every update takes the greater of the stored value and the new
occurrence, so an older run settling after a newer occurrence was skipped cannot
drag it backwards and replay settled work.

**The scheduler's watermark is per process and advances only past dispatched
work.** It moves to the boundary the tick reached, but only past occurrences the
tick finished dispatching. A claim or a dispatch that failed leaves its
occurrence available to a later poll, which is what stops a transient store
failure from silently losing a boundary.

The two are different questions. `lastFiredAt` answers "what does this trigger
owe after downtime". The in-process watermark answers "what has this process
already handled since it started", and a fresh process has none, which is why
first sight of a trigger establishes one and computes catch-up from `lastFiredAt`
when that durable cursor exists. A first-poll bound breach abandons the entire
owed list, including the current occurrence; subsequent polls still dispatch
the current occurrence subject to overlap. See [Overlap and catch-up](./policies.md).

## Both stores obey this contract

`SqlTriggerStore` and the in-memory `TestTriggers` store apply one claim
decision, not two implementations of one contract: the same refusal codes, the
same fences, the same expired-reservation reclaim, the same lease timing, the
same watermark rules. Each store reads its own snapshot and applies the writes
that decision answers. A test that swaps one for the other is testing the
same protocol. See [Test trigger code](../guides/testing.md).
