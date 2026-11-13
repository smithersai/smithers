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
   the decision and the pre-truncation journal `generation` read under the claim.
   The SQL transaction also quarantines the run's wait projection, preventing
   the engine's stale-run sweep from taking it over while the audit is open.
   The audit exists before anything is compensated or truncated,
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
    and on every non-terminal attached child's exact owner. The frame's derived
    state is written to the run row in that transaction, so its state always
    agrees with the surviving journal after commit. Archiving is not
    deletion: the records move aside so a forensic reader can still reach them.
    Archive rows use `(run_id, generation, seq)`, with each run's generation read
    before truncation advances it. Snapshot anchors above the parent frame and
    all anchors of archived attached children are removed atomically.
    Mutable deferred completions and clock deadlines named by those records are
    removed in the same transaction, so the rewound run cannot consume an
    answer or deadline from the discarded future.
    The same transaction advances the durable journal generation of the run
    and every attached child. Sync cursors from the previous generation fail
    with `lineage_changed`, even when the new journal head is below the old
    cursor. The error's `rewind` payload names the new generation and archive
    boundary; rebuild the projection from the retained history and start a
    fresh sync client from that boundary. The frame's structural lineage ID
    does not change.
11. **Cancel the claimed children**, recording each on the audit as it lands.
12. **Suspend the run with the state derived at the frame**, not the state the
    truncated future left on the row, and close the audit as `completed`.

## Step 10 is the commit point

Everything before it is reversible, and everything irreversible waits for it.

The archive call and its local commit flag are uninterruptible together. If
the call fails after committing, rewind checks for an empty live suffix and
the archived suffix tail in the audit's pre-truncation generation before choosing
rollback. When the audit records a generation, an archive row from an earlier
generation cannot prove this commit. Audits without one retain the
generation-agnostic archive check described below.
After a post-commit failure, the call attempts to finish child cancellation,
suspension, and audit closure while it still holds the lease, then returns the
original error. Already completed transitions are not repeated. If settlement
fails or commit evidence cannot be read, the audit stays `in_progress` at its
last durable phase, with compensation and workspace restoration intact for
recovery. The run remains quarantined even after its heartbeat expires.

Closing the SQL audit clears its quarantine in the same transaction. A failed,
uncommitted rewind restores the original wait projection; a completed rewind
clears the discarded future's wait. The quarantine token ties that change to
this audit, so closure cannot clear a replacement wait.

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
a caller to remember. A still-live owner's audit is deferred and remains
quarantined until a later layer build can recover it.

Recovery decides by evidence, not by assumption. An interrupted rewind whose
live suffix is gone checks that its recorded tail landed in the archive. When
the audit records `generation`, the generation truncated by this rewind,
`archivedAt(runId, seq, generation)` requires that exact coordinate; an earlier
rewind can archive the same sequence at the same or a lower frame. An absence on
both sides or, for a generation-bound audit, a match only in an earlier generation
is corruption to roll back.

Old persisted version-1 audits without `generation` still decode and retain the
old evidence rule, as do audits written against journals without generations:
`archivedAt(runId, seq)` accepts the tail in any generation after confirming the
live suffix is empty. Without an archive row they roll back. This fallback cannot
distinguish earlier archives, but rolling back a committed truncation would
reverse compensation the truncated history no longer explains. Explicit phases
`archive_committed` and `completed` remain sufficient evidence for both old and
new audits.

One audit it will not resolve is one whose run a live process still holds. That
one is declined: it keeps its `in_progress` status, stays in `pendingAudits`,
and a warning identifies the audit, run, error code and reason. Nothing is written to the audit,
so a later build finishes it. Recording it `failed`
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

If the run is already `completed`, `failed` or `cancelled`, recovery leaves its
status, state and ownership unchanged. It rolls back an uncommitted rewind or
closes a committed archive's audit as `completed` without claiming the terminal
run. An uncommitted rewind of a pending run restores `pending`, so refusing a
rewind does not remove the run from engine admission.

When recovery does close an audit as failed, it logs it at error level with the
audit id, run id, code and reason, so an operator learns about a rewind that
could not be finished without reading the audit table by hand.

## Fork lanes are reclaimed on the same build

A fork reserves its child run id, provisions the Jujutsu lane, then commits. A
process that dies between the last two steps leaves a registered lane behind
and a reservation every later mint has already counted past.

The same layer build forgets the lane of every reservation older than five
minutes whose fork never committed. The reserved ordinal is never handed out
again, so a retry lands under a fresh lane name rather than asking Jujutsu for
the one the leftover on disk still holds. The sweep first claims each stale
reservation as reclaiming, then forgets the lane, then records it forgotten.
Every build returns reclaiming intents again until that last write succeeds,
including rows reclaimed by older releases. A failed forget or completion write
is logged and retried on the next build. A reclaiming or forgotten reservation
refuses a fork still provisioning elsewhere with `fence_lost`. The refusal
transaction first resets it to reclaiming (clearing `forgotten_at_ms`, strictly
advancing `reclaimed_at_ms` with `max(now, previous + 1)`), then the error is
raised after commit. Its refused-commit
path attempts to forget the lane; startup retries if cleanup fails, and a
successful cleanup makes that later forget a no-op. A committed fork consumes
its reservation in the same transaction, so a later sweep cannot claim it.

If a process stalls past the stale window before `workspaceAdd` and crashes
after adding its lane but before `createFork`, a sweep that already recorded
the intent forgotten cannot discover the late lane. It remains registered;
nothing durable says it exists.

## Where to go next

- [Rewind a run to a frame](../guides/rewind-a-run.md): the call, its options,
  and what it returns.
- [Effect tiers](./effect-tiers.md): why an effect blocks.
- [Troubleshooting](../troubleshooting.md): what each refusal means.
