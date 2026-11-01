---
title: "Run writer locks"
description: "Decision record: PostgreSQL writes that name a partition, such as one run, share the schema's writer lock and take their partition's, so runs write side by side; writes that name none still commit alone."
sidebar:
  order: 10
---

Status: accepted, 2026-10-21. Supersedes the single schema-wide writer lock
that `PostgresDatabase` took for every write transaction.

## Context

`DurableWriter.write` promises serialized write transactions. On PostgreSQL,
`PostgresDatabase` kept the promise with one transaction-scoped advisory lock
per schema, `pg_advisory_xact_lock(hashtextextended(<schema>, 2099))`, taken
before every write transaction's first read. Every execution of every flow on
a deployment writes the one engine schema, so every write of every run waited
for every other run's.

The cost showed in production on 2026-10-21. A `repo/Clone` of a repository
that does not exist runs two steps and writes 35 journal entries. It settled in
42 to 198 seconds: 0.9 s per entry with 6 to 10 runs active, 5.7 s per entry
with 15 to 17. The whole deployment committed about 1 to 1.5 journal
transactions a second, however many runs were active. Each write is `BEGIN`,
the lock, one to three reads, the insert and `COMMIT`, five or more round trips
from a Durable Object through Hyperdrive to Neon while the lock is held.

Measured on the farm's PostgreSQL before this change (`DatabaseMetrics.tally`
on one alarm of a two-step not-found clone): 28 write transactions took the
schema's lock. Five of them were schema creation and migration checks that
every alarm repeats; the rest were the run's own writes.

The question: what lets two runs' writes commit at once without weakening any
guarantee a store relies on?

## Options

### A. A lock per partition, under a shared schema lock

A write names the partition its rows belong to, `{ partition: runId }`. Its
transaction holds the schema's lock shared and the partition's exclusively; a
write that names no partition holds the schema's lock exclusively, as before.
So:

- writes to one partition commit one at a time;
- writes to different partitions commit concurrently;
- a write that names no partition commits alone, excluding every other
  writer, which is what every write did before.

A nested write names its own partition and takes, before its savepoint,
whatever its transaction lacks: one more partition, or the whole schema.
Naming a partition is opt-in, so a write nobody audited stays as safe as it
was.

### B. `SERIALIZABLE` isolation and retry on `40001`, no advisory lock

The `DurableWriter` contract allows it, and it needs no declaration at any
call site: PostgreSQL's serializable snapshot isolation aborts one of any two
transactions whose interleaving no serial order explains, and the writer
replays it.

It fails on this workload. Predicate locks are taken at page granularity on
indexes and at relation granularity on a sequential scan, and the planner
sequentially scans small tables such as the lease table. Two runs' writes
then conflict whenever they touch the same page or table, which for the
journal's insert-heavy tables is most of the time, and every abort replays a
whole transaction at five or more Hyperdrive round trips. The contention moves
from a lock queue to a retry storm, harder to measure and to bound. It also
changes the isolation level under every store at once.

## Decision

Option A. It keeps the proven model, serialized write transactions, and
narrows its scope to what a write actually shares. It costs nothing a write
does not ask for: a write that names no partition behaves exactly as before.

`PostgresDatabase` implements it with two advisory lock key spaces, which
PostgreSQL never mixes:

| Lock                     | Key                                                 | Taken by                                               |
| ------------------------ | --------------------------------------------------- | ------------------------------------------------------ |
| the schema, exclusively  | `hashtextextended(schema, 2099)`, one key           | a write that names no partition                        |
| the schema, shared       | the same key                                        | a write that names a partition                         |
| a partition, exclusively | `(hashtext(schema), hashtext(partition))`, two keys | a write that names it, or a nested write that joins it |

The schema lock always comes first. A process on a release before this
change takes the schema lock exclusively for every write, so it still excludes
every new writer and the two releases can run side by side during a deploy.

Writes that touch one run's rows name that run:

- `@smthrs/journal`: every append, checkpoint and compaction, and every
  `SqlConsensus` lease operation (keyed by the lease);
- `@smthrs/run-store`: every single-run write of `RunStore` (create, claim,
  activate, heartbeat, transitions, steal, cancellation of one run) and
  every `AttemptStore` write;
- `@smthrs/engine-store`: the per-execution writes of `DurableEngineState`
  (deferred completions, clock deadlines, waiting columns), every action
  attempt's transaction, and the drive's own transactions: admission,
  activation, transitions, a handoff, a wake and a parent's wake, each named
  for the run whose rows it changes.

What stays schema-wide: schema creation, migrations, and every write that
decides from rows across runs: a run-parent edge whose child already has
children, and its cycle walk (`admit` opens on the schema for it), a run's
cancellation and its cascade to every descendant, a lineage's or a tree's
cancellation, step-cache publication, plan storage, retention and time
travel's truncations. A nested write to another run, such as a handoff's
successor or a cancelled child, joins that run's partition instead, and a
terminal transition that ends its children joins each child's partition
before it reads the child's rows to decide. A new edge whose child has no
children can close no cycle, so it joins its child's and its parent's
partitions and walks nothing. An alarm of a root run, start to settlement,
therefore takes no schema-wide lock once its schema is installed:
`platform-cloudflare/test/DriveWrites.test.ts` asserts `schemaWide` is zero. A
run's waits and a child's admission take none either:
`engine-store/test/RunParentReplayLock.test.ts` drives both beside another run's
open writer.

## What still guarantees one writer per run

Three mechanisms, each independent of the lock's scope:

1. **The partition lock.** Every write that changes a run's rows names that
   run, so two writes to one run, from one process or two, take the same lock
   and commit one at a time. `MAX(seq) + 1`, read inside the transaction after
   the lock, therefore allocates each sequence once.
2. **The owner fence.** Every owned write runs `Consensus.guard` inside its
   transaction: a read of the run's lease row that fails with `fence_lost`
   unless the writer still owns the run. Every change to a lease row, a claim,
   steal, activation or release, is itself a write to that run's partition, so
   no takeover can commit between a guard and the write beside it.
3. **The primary key.** `flows_journal_events` is keyed by `(run_id, seq)`.
   Were the first two ever bypassed, a second insert of one sequence fails on
   the key rather than forking the run's history.

## Two incarnations of one run

A Durable Object's watchdog alarm can start a second incarnation of a run while
the first is still committing, for example after an isolate reset whose
connection the server has not yet closed. The second incarnation takes the run
over through the lease, a write to the run's partition, so it waits for the
first incarnation's open transaction to commit or roll back. The first
incarnation's next write then holds the partition lock, reads the new lease in
its guard and fails with `fence_lost`. Its entries all precede the takeover and
the successor's all follow it, in one gap-free sequence:
`journal/test/JournalPartitions.test.ts` drives exactly this on PostgreSQL.

## Consequences

- Naming a partition is a claim the caller makes: the write reads for its
  decisions, and changes, only rows its partition owns. A wrong claim
  reintroduces the races serialization prevents, so each store that names one
  says why in its code, and a store that cannot tell names none.
- A nested write that names no partition inside a partitioned transaction
  widens it to the whole schema. Two transactions widening at once deadlock;
  PostgreSQL breaks the deadlock by failing one with `40P01`, and the writer
  replays it. A partitioned transaction that widens is correct but slow, so
  `DatabaseMetrics.tally` counts `schemaWide` transactions and each Durable
  Object alarm logs the count.
- Rolling back a savepoint releases the locks taken inside it. The adapter
  takes a nested write's lock before its savepoint, and forgets what a rolled
  back savepoint took, so a later nested write takes it again.
- The process-local permit in `DurableWriter.make` still serializes one
  writer's outermost writes. A Durable Object builds its own writer per alarm,
  so it does not bind across runs there.
- SQLite ignores partitions: its file lock serializes every write.

## Fewer transactions per drive

Locks per run stop runs waiting for each other; they do not shorten one run.
A not-found clone's alarm still ran 38 write transactions, one per journal
entry the engine's node bookkeeping wrote, each `BEGIN`, a lock, two to four
statements and `COMMIT` through Hyperdrive. Three ways to write a drive's
records in fewer:

1. **The lossy queue, flushed once per step.** It already batches entries
   into one transaction. But it is unfenced, drops entries when full, and
   allocates a sequence at admission, so an entry can land behind a
   reader's cursor; a node record that binds a plan's progress must not.
2. **One transaction per drive tick.** Every write between two action
   effects joins one ambient transaction. It needs a connection shared by
   the drive's concurrent fibers, a commit point the engine must call
   before every effect, and replay of a whole tick on a transient failure;
   that changes the engine's failure model, and the gain over 3 is the
   handful of transactions 3 leaves.
3. **Deferred durable entries** (chosen). `Journal.emitDeferred` queues a
   fenced entry, and the run's next durable write through the journal commits
   it first: one fence check and one floor read for the batch, then an insert
   each. Every attempt opens in a write of its run and every drive ends in
   one, so a node's records are durable before anything acts on them. A
   process that dies first loses them as it would lose records it had not
   emitted yet: no later entry or attempt of the run committed either,
   because those commit through the journal, which writes queued entries
   first.

The engine queues every node record but the plan record, which it reads back
and repairs on conflict. The not-found clone's alarm now writes its 38
entries in 14 transactions: admission, claim, activation, the resume, the
plan record, then per step its heartbeat, its start, its pre-image anchor
and its finish, and the settlement. Each of those orders a durable fact
before an effect or a peer depends on it (the two-phase claim, the fence
before a step reads its cache, the attempt row before the step's side
effect, the anchor time travel needs before the body runs), so fusing them
is a change to the engine's contract, not to its storage.

## Resume recovery

Sibling savepoints can each flush the same deferred batch before the outer
transaction commits. Each entry retains its allocated producer sequence across
those flushes and retries, so an entry without an explicit sequence still has
one identity. Commit cleanup removes only the captured batch and is idempotent:
a second callback succeeds even when the first already removed it. The journal's
sibling-savepoint regression and the agent's answered-module resume cases cover
this boundary.

## Evidence

`test/WriterLock.bench.ts` (`pnpm --filter @smthrs/database bench`) on the
Latitude farm's PostgreSQL 17 and PgBouncer, 2026-10-21, load average about
19 on 48 cores. Each writer is its own one-connection client; each write
inserts one row.

| Writers                   | PgBouncer | PostgreSQL | PostgreSQL, 2 ms each way |
| ------------------------- | --------- | ---------- | ------------------------- |
| 1 writer                  | 1522/s    | 2302/s     | 57/s                      |
| 16 writers, no partition  | 2307/s    | 2722/s     | 97/s                      |
| 16 writers, 1 partition   | 2331/s    | 2585/s     | 103/s                     |
| 16 writers, 16 partitions | 4362/s    | 5880/s     | 757/s                     |
| 16 writers, 16 schemas    | 4607/s    | 5847/s     | 759/s                     |

Behind a slow network, the shape of a Worker writing through Hyperdrive,
sixteen runs write 7.8 times as fast with a partition each as with the
schema's lock, as fast as sixteen separate schemas. One partition is as slow as
the schema's lock, as it must be. `journal/test/JournalPartitions.test.ts`
measures the journal itself: eight runs appending 35 entries each finished in
1390 ms against 1217 ms for one run alone (1.14 times); with every write on
the schema's lock the same eight took 6786 ms (5.7 times). Limitations: one
machine, a synthetic delay instead of Hyperdrive, and a farm shared with other
suites; read the ratios, not the rates.

`platform-cloudflare/test/DriveWrites.test.ts` drives `repo/Clone`'s plan on
the not-found path, 35 run entries as in production, through
`ExecutionObject.alarm` on the MacBook's compose PostgreSQL behind the same
2 ms slow network (load average 16 to 30, so single runs varied from 2.6 to
12.7 s). Each alarm runs 38 write transactions. With every one on the
schema's lock, as before this change, eight alarms side by side took 4.3 to 4.6
times as long as one, each waiting 9.9 to 13.4 s in total for the lock. With
the run's partition, none is schema-wide and the eight took 0.93 to 1.18 times
as long as one, each waiting 0.25 to 0.55 s in total for its locks. With the
journal's and the lease strategy's writes partitioned but not yet the stores',
8 of the 38 stayed schema-wide and the eight took 3.7 times as long: a
partition helps only once a run's every write names it.

The `flows_run_source` singleton that the `flows_runs` triggers bump
(run-store migration 0003) is the one row every run still shares, and the
exception to "a partition's write changes only its own rows": every
transaction that updates a run's row increments it through a trigger. The
increment is one atomic statement, so its row lock keeps it correct, and it
orders those transactions from that update to `COMMIT`. Seven of an alarm's
38 transactions do. At eight concurrent runs it costs nothing visible, so it
stays. `lockWaitMs` times advisory locks only: a wait on that row would show
as `durationMs` rising while `lockWaitMs` stays flat, and in the eight-alarm
test above.
