---
title: "Delete old run history"
description: "Run an explicit retention pass over finished runs: the age threshold, the dry run, the lineage guard that keeps a run a live one still needs, and what smthrs gc does."
sidebar:
  order: 5
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/engine-store/docs/guides/delete-old-run-history.md"
---

Nothing in the durable stores forgets on its own. A finished run keeps its row,
every attempt, every journal event, and every archived frame forever, and
journal compaction is off by default, so the file only grows. That is the right
default, because a run's history is the only account of what an agent did to a
repository. Deleting it is an operator decision, taken explicitly.

## Run a pass

`Retention.retain` deletes up to `limit` aged terminal runs and their dependents
in one transaction:

```ts
import { Retention } from "@smthrs/engine-store"
import * as Effect from "effect/Effect"

const collect = Effect.gen(function*() {
  const retention = yield* Retention.Retention
  return yield* retention.retain({
    olderThanMs: 30 * 24 * 60 * 60 * 1000,
    limit: 1000,
    dryRun: true
  })
})
```

`Retention.layer` provides the service and needs `SqlClient` and
[`@smthrs/journal`](https://journal.smithers.sh/reference/api/)'s `Journal`.

`olderThanMs` is how long a run must have been finished, measured from
`finished_at_ms` or from `created_at_ms` for a terminal row that never recorded
one. Zero collects every terminal run; a negative value is read as zero.

`limit` bounds one pass and defaults to `Retention.defaultLimit`, which is 1000.
Retention is idempotent. For a fixed, finite, acyclic lineage and a positive
integer limit, each successful non-dry pass removes at least one collectable
run while any remain. This includes continuation chains longer
than the bound. Selection prioritizes deeper continuation children before
parents, then age and run id; the report lists selected runs oldest first.
Parents pinned by children excluded by age or live lineage do not consume the
bound. Protected runs remain until eligible. Zero or a negative limit deletes
nothing.

`dryRun` computes and reports the pass without deleting anything. Under a dry
run the report names exactly the runs a real pass would remove, which is what
makes it worth trusting.

## Read the report

`RetainReport` carries the `cutoffMs`, the `runIds` deleted oldest first, per
table counts (`runs`, `attempts`, `clockDeadlines`, `deferredCompletions`,
`journalEntries`, `journalCheckpoints`, `archiveEntries`,
`timeTravelReceipts`), the `dryRun` flag, and two retention lists:

- `retainedForLiveDescendants`: aged terminal runs left in place because a
  descendant is not terminal, or is terminal and is not being deleted by this
  pass.
- `retainedForLiveAncestors`: aged terminal runs left in place because an
  ancestor is not terminal. That ancestor can still read the run's settled
  result through `agent/await`, which answers out of the run row.

A run retained for both reasons is reported under `retainedForLiveDescendants`,
and at most `limit` runs are reported, so the report costs no more than the
pass.

## Three properties make it safe on a live workspace

**One transaction.** Every delete runs inside a single `journal.transact`, so a
crash leaves either a run with all of its rows or none of them, never a run row
whose history is gone or history whose run row is gone.

**Terminal and aged only.** A run is a candidate only when its status is
`completed`, `failed`, or `cancelled` and it finished before the cutoff. A
`pending`, `running`, or `suspended` row belongs to work that can still resume,
at any age.

**Nothing a live run still needs.** A candidate is retained when a live run
stands on either side of it in the lineage, over both relations that make one
run the parent of another: the `flows_run_parents` edge a spawned child is
recorded under, and the `parent_run_id` column the rounds of one trampoline
lineage are chained through. The lineage filters run before the bound, which is
what makes a bounded pass converge: otherwise a workspace whose oldest thousand
aged runs all hang under one parked parent would fill the window with runs the
pass then has to retain, pass after pass.

Journal history is deleted outright rather than compacted to a checkpoint.
`Journal.checkpoint` and `Journal.compact` are owner-fenced and require a
`running` run under the exact owner, so neither can be called for a finished,
ownerless run at all. Deleting is strictly stronger, and it happens in the same
transaction as the run row.

## Collect across both of a project's databases

A project keeps its history in two files, the control plane's database and the
engine's, and a sweep of one without the other leaves half of a deleted run
behind. `Retention.collect` is the host-facing pass, taking the database as a
service and running once per file:

```ts
import { Retention } from "@smthrs/engine-store"

const pass = Retention.collect({
  olderThanMs: Date.now() - 30 * 24 * 60 * 60 * 1000,
  database: ".flows/engine.db",
  dryRun: false
})
```

Note the difference in units: `Service.retain` takes a duration, while
`collect` takes an absolute epoch millisecond threshold. `collect` returns a
`Retention.Report` with the `database` label, the threshold, the `runs`
removed, `deleted` row counts per table (empty under a dry run), and the
`dryRun` flag.

`collect` reads eligibility and deletes inside one retryable write transaction.
A concurrent attachment to a live parent cannot slip between that scan and
deletion. If contention causes a retry, the pass recomputes its candidates.
Dry runs read the same guard inside a transaction without modifying history
or schema; their report is a snapshot, not a reservation for a later sweep.

`collect` runs the same deletion and the same lineage guard as `retain`, so
neither can hold a shorter table list than the other. It handles a database
that composed fewer stores: the control plane's file migrates the run store and
the journal and nothing else, so the guard drops the edge-table half of the walk
there and keeps the `parent_run_id` half.

`Retention.eligible(olderThanMs, limit?)` returns just the candidate run ids,
for a tool that wants to show them before deleting anything.

## The CLI already does this

[`smthrs gc`](https://smithers.sh/docs/reference/cli/gc/) is `collect` over a project's databases, with
`--older-than` defaulting to 30 days and `--dry-run` available. It refuses
`--older-than 0s`, because that is "delete all history" wearing the spelling of
a retention policy. After retention it runs `ArtifactGc` over the engine's
`.flows/objects` directory with the default 14-day grace, so blobs the deleted
runs were the last to reference are collected too.

Nothing schedules any of this. Automatic retention stays opt-in, for the same
reason artifact collection does: deletion is the irreversible direction, and a
human approving a plan must be approving the deletions.

## Related

- [Collect unreferenced artifacts](/guides/collect-unreferenced-artifacts/): the
  blob half of reclaiming space.
- [Retention](https://smithers.sh/docs/guides/retention/) on smithers.sh: the operator's
  procedure.
