---
title: "The rewind protocol"
description: "The ordered, fenced protocol behind one rewind call: what runs before the commit point, what runs after it, and how a crash in the middle is finished on the next layer build."
sidebar:
  order: 4
---

`rewind` is one call, and behind it is the only destructive protocol this
package has. Everything about its ordering exists to answer one question: if
the process dies at this exact line, what does the next process see?

## The order of operations

1. **Validate the position**, before anything durable exists. A refused frame
   leaves no claim, no audit row, and no refreshed anchor behind.
2. **Claim and activate the run**, then hold the ownership lease with a
   heartbeat for as long as the protocol runs. A slow compensation or a large
   archive must not leave the row looking abandoned to a co-located engine.
3. **Re-read the journal tail under the claim** and compare it with what
   validation observed. Validation runs before the claim, so another executor
   could have claimed the idle row, appended records, and released it inside
   that window. A moved tail is `busy`, not a silent truncation of records
   validation would have refused.
4. **Apply the `Options.rateLimit` limiter and write the audit row**, carrying
   the decision. The audit exists before anything is compensated or truncated,
   so a crash always leaves a row recovery can find. A build that supplies no
   limiter allows every rewind and records `{ allowed: true, checkedAtMs }`.
5. **Read the frame's anchor, the descendants, and the suffix**, and fold the
   effect-boundary evidence in it.
6. **Assess.** An attached child that is still executing refuses the rewind; so
   does a live detached child under the `block` policy. One blocking effect
   refuses the whole operation with `irreversible`. See
   [Effect tiers](./effect-tiers.md) for how each verdict is reached.
7. **Compensate the irreversible effects**, persisting the accumulated receipts
   after each handler and before the next irreversible step. Receipts that
   reached storage are what let recovery tell an effect that was already rolled
   back from one that never was.
8. **Restore the workspace** to the frame's recorded pointer.
9. **Write the cancellation plan, then claim every child it names.** A claim is
   reversible; a cancellation is not.
10. **Archive and truncate the suffix atomically**, fenced on the parent's owner
    and on every non-terminal attached child's exact owner. Archiving is not
    deletion: the records move aside so a forensic reader can still reach them.
    Archive rows use `(run_id, generation, seq)`, with each run's generation read
    before truncation advances it. Snapshot anchors above the parent frame and
    all anchors of archived attached children are removed atomically.
    Mutable deferred completions and clock deadlines named by those records are
    removed in the same transaction, so the rewound run cannot consume an
    answer or deadline from the discarded future.
11. **Cancel the claimed children**, recording each on the audit as it lands.
12. **Suspend the run with the state derived at the frame**, not the state the
    truncated future left on the row, and close the audit as `completed`.

## Step 10 is the commit point

Everything before it is reversible, and everything irreversible waits for it.

The archive call and its local commit flag are uninterruptible together. If
the call fails after committing, rewind checks for an empty live suffix and
the archived suffix tail before choosing rollback. A durable archive keeps
the audit `in_progress` at phase `archive_committed`, with compensation and
workspace restoration intact for recovery to finish. If the evidence cannot
be read, the audit stays open and rollback is deferred.

Cancelling a child is terminal and has no inverse, so it runs only after the
commit. A rewind that fails earlier leaves every child exactly as it was:
pre-commit child claims are released, an originally suspended child returns to
that status, and a child claimed from pending or dead-running is parked
suspended, which is the run store's ownership-clearing reversible state.

The cancellations the operator asked for are written to the audit detail
**before** the commit, so a crash in the middle of them is finished by the next
recovery pass instead of being silently dropped. An audit that recorded only
the children it had already cancelled would let recovery close the row as
complete with the rest quietly abandoned.

Terminal descendants are disclosed as warnings rather than cancelled, because
their external effects cannot be erased by deleting a parent's suffix.

## Recovery is not an operation

Building `TimeTravel.layer` finishes or rolls back every rewind a crash
interrupted, before the service accepts new work. There is no recovery call for
a caller to remember, and no window in which the service is up but the last
crash is unresolved.

Recovery decides by evidence, not by assumption. An interrupted rewind whose
live suffix is gone counts as committed only if the suffix actually landed in
the archive; an absence on both sides is corruption to roll back, never success
to assume.

One audit it will not resolve is one whose run a live process still holds. That
one is declined: it keeps its `in_progress` status, stays in `pendingAudits`,
and nothing is written, so a later build finishes it. Recording it `failed`
would close it terminally and drop it from `pendingAudits` forever, and a
rewind a living process still owns is never stolen.

`Options.isAlive` decides what "still live" means:

```ts
import * as Ownership from "@smthrs/run-store/Ownership"
import { TimeTravel } from "@smthrs/time-travel"

const layer = TimeTravel.layerWith({ isAlive: Ownership.leaseLiveness() })
```

The default is `Ownership.leaseLiveness()`, the same check the engine's own run
driver applies to those rows: an owner is alive while its persisted heartbeat
is younger than `Ownership.heartbeatStaleAfter`. That is the weakest honest
answer every host can give. A deployment that can say more supplies its own
check and refuses the takeover for longer.

A supplied check can only ever refuse a takeover, never widen one. The evidence
recovery hands the run store is always `lease-expired`, and the store
re-verifies that claim inside the same write.

When recovery does close an audit as failed, it logs it at error level with the
audit id, the code, and the reason, so an operator learns about a rewind that
could not be finished without reading the audit table by hand.

## Fork lanes are reclaimed on the same build

A fork reserves its child run id, provisions the Jujutsu lane, then commits. A
process that dies between the last two steps leaves a registered lane behind
and a reservation every later mint has already counted past.

The same layer build forgets the lane of every reservation older than five
minutes whose fork never committed. The reserved ordinal is never handed out
again, so a retry lands under a fresh lane name rather than asking Jujutsu for
the one the leftover on disk still holds. A lane that cannot be forgotten is
reported and left, and because its name is never reused it blocks nothing.

## Where to go next

- [Rewind a run to a frame](../guides/rewind-a-run.md): the call, its options,
  and what it returns.
- [Effect tiers](./effect-tiers.md): why an effect blocks.
- [Troubleshooting](../troubleshooting.md): what each refusal means.

Rewind advances a durable journal generation in the same SQL transaction as
archiving and truncating the history, including attached children. Sync cursors
from the previous generation fail with `lineage_changed`, even when the new
journal head is below the old cursor. The error's `rewind` payload names the
new generation and archive boundary; rebuild the projection from the current
retained history and start a fresh sync client from that boundary. The frame's structural lineage ID itself
does not change.
