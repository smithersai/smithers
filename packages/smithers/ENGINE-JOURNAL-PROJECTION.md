# Recorded engine evidence in control runs

The private `src/internal/EngineJournalProjection.ts` helper projects the existing
durable engine journal into the existing control journal. It adds no database,
table, public package export, execution service, or gateway procedure. The caller
establishes which native execution belongs to the control run before constructing
the helper.

```ts
const projection = yield * EngineJournalProjection.make({
  controlRunId,
  executionId,
  engineJournal,
  controlJournal,
  engineState, // existing DurableEngineState.runChildren
  runLineage, // optional RunStore.lineage: trampoline rounds of one lineage
  onRecord // optional hook, called before each native record is copied
})
const follower = yield * Effect.forkScoped(projection.follow)
// Execute through the existing registered engine/catalog.
yield * projection.catchUp
```

For one accepted native launch, start
`projection.followUntilSettled(engineRunStore)` in the host scope. It tolerates
the run row not existing yet, waits while the root is nonterminal, then performs
another catch-up after reading the committed terminal row. A handler-scoped
follower is insufficient: the driver commits the handler's terminal result after
the handler returns. The host may keep ordinary `follow` alive for detached work
that outlives the native root.

When `runLineage` is supplied, each traversal also visits every round of the
root's trampoline lineage, the rows `RunStore.lineage` returns for it, so a
continuation's events reach the same control run as the round that started it.
A lineage read that omits the requested run or returns a member of another
lineage fails with `decode_failed` rather than being guessed at. The
supervisor passes the native RunStore's `lineage`; a legacy adapter may omit
it, and then only spawn edges are traversed. Nothing is inferred from
execution IDs.

`onRecord(entry, generation)` runs for each native record BEFORE that record is
copied into the control journal, so a client that reads the copied record can
act on it knowing the host already has. Recovery rereads pages, so the hook can
fire more than once for one record and must be repeatable. Its failures are the
caller's to absorb.

The host owns the scope and can share one follower per control run through its
existing resource map. `catchUp` completes after the copied entries have durable
destination receipts. A projection refusal remains a `JournalError` (or a
`RunStoreError` when reading settlement); it does not
prove that an already-executed native effect failed or authorize repeating it.
This helper alone does not install the host wiring or render coding statuses.

## Internal event envelopes

Every `catchUp` first emits `control.engine.bound` into the control run, with
payload `{ version: 1, controlRunId, executionId }` under a deterministic
producer ID, so repeats deduplicate. It is the one record that associates a
control run with its native root; gateway projections and execution facts read
it to find the native execution. Only the supervisor's validated native root
creates it.

`control.engine.event` uses the existing open `ControlEvent.payload` contract:

```ts
{
  version: 1,
  executionId: string,
  generation: number,
  sequence: number,
  eventId: string,
  sourceId: string,
  sourceSequence: number,
  emittedAtMs: number,
  eventType: string,
  payload: unknown,
  meta: unknown
}
```

The nested native kind, payload, metadata, timestamp, and identities come from
the committed journal entry. An encoded result appears only if that entry
contains it. Nothing reconstructs an outcome from current source, an attempt
status, or a model prediction. Control ingestion has its own sequence and time;
the envelope retains the native coordinates separately.

The wrapper is deliberate. `ControlLive` exposes journal payload but not metadata,
and its generic ancestry/monitor folds must not interpret a child's native run
decision as the control root's own lifecycle. Existing wire schemas remain
unchanged; readers opt into the native envelope explicitly.

`control.engine.projection-gap` records the execution, generation, and reason:
`rewound`, `compacted`, or an actual journal read failure code.
Applicable native sequence boundaries accompany it. Native sequences are ordered
but are not contiguous: SqlJournal reserves them before commit and deliberately
leaves abandoned transaction reservations unused. Such holes cannot establish
missing evidence and do not produce a projection gap. A gap is evidence of missing
or discontinuous observation, never a fabricated completion or passing check.
If a source generation lookup fails, the gap has
`generation: null` and preserves `lastObservedGeneration` separately. It does not
guess the current generation from a stale cursor.

## Replay and ownership

Call `catchUp` and the follow helpers outside any native transaction context.
Otherwise a caller could read its own uncommitted source writes despite matching
generation reads. Supplying another Journal service does not clear the enclosing
SQL transaction service. The host supervisor captures a clean context for this.

The helper walks `DurableEngineState.runChildren` edges from the authorized native
root and deduplicates a shared child within a traversal. Similar execution-ID
prefixes establish no ownership. Removing an edge stops future traversal through
it; already-recorded observations remain historical evidence.

Native journal pages contain at most 256 entries. Two reads of the monotone native
generation bracket each page; a rewind crossing that read discards the page and
retries. Page reads no longer acquire the native write lock. A read on the same
connection still waits behind that connection's open transaction; an independent
WAL reader can read committed evidence while a writer holds its transaction.
The destination producer ID hashes the native execution and
generation. Its source sequence is the native journal's global per-run sequence,
which distinguishes native producers that reuse their own source sequence.

A cursor advances only after the destination's durable event or omission-gap receipt. Exact retries,
including a lost acknowledgement, use the journal's existing content deduplication.
Restarting the helper rereads source pages and deduplicates them; there is no new
durable cursor store. A rewind uses a new producer generation, retains prior
evidence, and records a discontinuity. Compaction records the unavailable prefix
before resuming at the source's surviving checkpoint event. If the destination
rejects a native envelope as `invalid_event` (for example its encoded byte bound),
the helper records an exact per-sequence omission and continues into later events
and children. Storage failures retain the cursor and remain failures.

Live following uses `Journal.changes` only as a wake hint plus the journal's same
one-second durable recheck pattern. Authoritative paging detects cross-process
writes, lost local wakeups, newly linked children, and rewinds below an old cursor.
`catchUp` and following serialize within one helper. Ordering across different
native executions is observation order, not an invented global execution clock.

## Host supervision

`internal/EngineJournalSupervisor` is a private scoped composition helper. Its
`make` accepts the already-materialized native journal, native RunStore and
DurableEngineState, plus the control journal and ControlRuntime. Construct it
outside admission transactions, wrap the existing ControlExecutor with `wrap`,
and run `recover` in the same host scope. It adds no service tag, public package
export, database, table, checkpoint, or executor protocol.

Accepted launches durably record `control.engine.projection-started` before the
wrapper returns. Pending or rejected launches record no observation. Following
begins through the existing journal `whenCommitted` hook and a captured clean
host context, so neither native reads nor background following inherit an open
control transaction. The admission's control-row read deliberately stays in its
caller transaction. An isolated pooled connection cannot see that uncommitted
row; an isolated read on a single-connection adapter waits behind the admission's
connection semaphore and would deadlock its own caller. A rolled-back admission
starts no follower. At most one
follower per root/generation runs in this host; a replacement generation stops
its predecessor. Scope shutdown leaves incomplete observation available for
restart instead of recording a false execution failure.

Before copying any native event, the supervisor validates the actual native
`agent/run` row, matching control `planId`, no native parent execution, and no
recorded run-parent edges. Fork ancestry and copied input `runId` are not root
identity. A missing row after acceptance is awaited; a control run that settles
without a native row produces a visible gap. Foreign rows never disclose their
events through a coincidentally equal control ID.

The settled marker, `control.engine.projection-settled`, is written only after the projector sees the native terminal
commit and drains its final events. Both markers carry
`{ version: 1, executionId, generation }` and reuse deterministic producer IDs.
Recovery includes terminal control/native rows with missing observation, checks
native identity before paging control history, and skips already-settled current
generations. Operational observation failures write a gap. Failure to persist
the marker or gap is logged, while an executor's actual accepted launch remains
accepted; observation failure does not reverse execution that already started.
Restart can recover these roots without relying on a surviving started marker.
Gap producer IDs and payloads use stable error codes/messages; process-specific
stack strings cannot grow a new duplicate gap on each restart. If a previously
observed native row is removed, following stops with an explicit gap. Follow
failures re-read the native root generation for attribution, using `null` if that
read itself fails. They never label a rewind failure with the original generation.

A spontaneous rewind during active following can project that generation's
events and rewind gap before its next started marker; the host cannot promise
started-before-events for every externally initiated rewind. Settlement still
requires that generation's terminal drain. Recovery scans retained control
history to find its markers; its cost grows with retained observations, and an
unreadable or compacted control history produces an explicit recovery gap. This
uses existing journal APIs rather than adding a separate cursor/index store.
Native root identity checks use brief native transactions, including the
once-per-second check while an accepted driver's row has not appeared. Ordinary
projection pages use the lock-free generation bracket described above.

This lifetime covers the authorized native root and its recorded children. A
root-terminal marker does not assert that detached descendants have finished.
The helper does not enforce shared cross-process execution budgets or replace
workspace executor ownership.

## Validation

Tests use real SQLite journal/store layers. They cover native outcome preservation,
multiple producers, durable child edges and prefix lookalikes, restart deduplication,
lost destination acknowledgements, changed values at a reused sequence after
rewind, compaction, legitimate rollback allocation holes, multi-page replay, new children, source
read failure/recovery, and a separate SQLite writer whose local notifications
cannot wake the source journal. The last test exercises the durable recheck.
Settlement coverage commits final evidence between the earlier page read and the
terminal run-row read, so only the final drain can include that record. It also
starts following before the native run row exists and verifies failures of either
generation read remain visible without inventing a current generation. Real
checkpoint/compact operations preserve the surviving checkpoint event, a bounded
destination rejects an oversized envelope without wedging later evidence, and an
independent writer can hold its transaction while the observer reads committed
source pages. A rewind injected between page and final generation read cannot
label the stale page as belonging to a current generation.
Supervisor tests use separate real SQLite journals and native stores for
admission/commit ordering, rollback isolation, native terminal drain, missing and
foreign roots, pending/rejected acceptance, restart after scope shutdown, terminal
recovery without markers, generation changes, deduplication, and marker-write
failure that preserves actual accepted execution.
Additional tests assert the control read sees the caller's real SQL transaction
service while native reads do not, changing process stacks deduplicate to one
gap, and removal after a rewind terminates following with current-generation
evidence.
