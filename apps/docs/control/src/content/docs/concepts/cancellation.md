---
title: "Cancellation attribution"
description: "A durable cancellation is anonymous on its own. How the journal adds back who asked and why, the three sources in the order they rank, and why a cascade inherits its ancestor's principal."
sidebar:
  order: 6
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/control/docs/concepts/cancellation.md"
---

A durable cancellation records that somebody asked and when, and nothing else.
`flows_runs.cancel_requested_at_ms` is one number. It cannot say who, why, or
whether this run was asked for by name rather than swept up in an ancestor's
cascade.

`RunSummary.cancellation` is the attribution the journal adds back:

| Field          | Meaning                                                                   |
| -------------- | ------------------------------------------------------------------------- |
| `requestedAt`  | When the cancellation was asked for.                                      |
| `source`       | `control`, `cascade`, or `engine`.                                        |
| `principal`    | Who asked. Present on a `control` source and on the `cascade` it started. |
| `reason`       | Why, as the operator stated it.                                           |
| `cascadedFrom` | The cancelled ancestor this run was swept up with.                        |

`control` is an operator asking through this plane, and it is the only source
that can name a principal. `cascade` is a run swept up in an ancestor's
cancellation. `engine` is everything the runtime decided on its own account: a
lease expiry, a budget, a supervisor.

## The three sources, in order

`Cancellation.attribute` is the fold, and a run's own evidence outranks its
ancestors':

1. **A `control.run.cancel-requested` entry names this run.** Somebody asked
   for it by name, and the entry says who and why.
2. **A cancelled ancestor exists.** The run reports `cascade`, names the
   nearest cancelled ancestor, and inherits that ancestor's principal and
   reason. The honest answer to "who cancelled this child" is the operator who
   cancelled its parent.
3. **Neither.** The engine cancelled the run on its own account. There is no
   principal to report, and inventing one would be worse than saying nothing.

A run counts as cancelled when any of three things is true: the run store's
`cancel_requested_at_ms` is set, the engine journaled
`flows.engine.interrupted` with outcome `cancelled`, or an attributed request
names the run. The third matters because a control plane cancelling a run it
owns interrupts the fiber rather than writing the request column, and its
journal entry is the whole record.

```ts
import * as Cancellation from "@smthrs/control/Cancellation"

const attributed = Cancellation.attribute({
  runs: [
    { runId: "run-1", cancelRequestedAt: 10 },
    { runId: "run-2", parentRunId: "run-1", cancelledAt: 12 }
  ],
  requests: new Map([[
    "run-1",
    { requestedAt: 10, principal: { id: "ada", kind: "user", stampedAt: 10 }, reason: "budget" }
  ]])
})

attributed.get("run-1")
// { requestedAt: 10, source: "control", principal: { id: "ada", ... }, reason: "budget" }
attributed.get("run-2")
// { requestedAt: 12, source: "cascade", principal: { id: "ada", ... }, reason: "budget", cascadedFrom: "run-1" }
```

## Why the fold is pure and scope-independent

`attribute` reads whatever evidence it is handed and never issues a query, so
the caller chooses how much to read. `SqlControlRuntime` uses two scopes:

- A **listing** folds the whole database, because every row is going to be
  answered for anyway.
- **Reading one run** folds that run and its ancestor chain, which is the
  smallest scope that can still answer the question.

Cascade is a fact about a run's ancestors, so it cannot be decided one row at a
time: the request that cancelled a child may be several rounds up the chain.
Reading one run therefore costs one recursive walk over `parent_run_id` plus
one spawn-edge read per nesting level, and never grows with the size of the
database. That is what keeps the cost of steering or cancelling a run
independent of how many runs exist.

The ancestor walk carries a visited set. A cyclic parent chain is not reachable
through the engine's own cycle detection, but a projection that hung on corrupt
ancestry would take the control plane down with it.

## Where the attribution is written

`cancel` writes the principal and the reason onto its
`control.run.cancel-requested` entry, inside the mutation's own transaction, so
a cancellation cannot commit anonymously. `resume` records the same pair on its
`control.run.resume` entry.

The request, attribution, and acceptance receipt commit before the local fiber
is interrupted. Cancellation then awaits its finalizers without holding the
mutation semaphore or journal transaction, so cleanup can signal another run
or use the same durable writer. A second transaction rechecks the original
ownership fence and commits the terminal status and event together. A terminal
outcome reached during cleanup is preserved. If cleanup loses ownership, the
durable request remains for the owner or a later cancel attempt.

Attribution is keyed on the request being newly recorded. `cancel` re-executes
on every ask, so attributing every ask would journal one
`control.run.cancel-requested` per ask for a single cancellation. The executor
answers `already-requested` when the engine column was set before this call
arrived, and that answer suppresses the second record.

A cancel whose executor reports that the engine row has already settled writes
no attribution, because nobody cancelled anything, and reconciles the control
row onto the engine's own status instead. Nothing else converges the two rows,
so a control row left disagreeing with a settled engine row would list the run
as live forever.

Over RPC the `Cancel` procedure carries the reason and refuses a caller-named
principal. The server stamps the identity it authenticated, so a remote
operator states why and never states who. The principal's `stampedAt` records
when that authentication happened; it is evidence about an external event,
never a value any decision is replayed from.

## Where to go next

- [Cancel a run, and restart one](/guides/cancel-and-resume/): the verb,
  and what each receipt means.
- [Run lineage](/concepts/lineage/): the ancestor chain a cascade walks.
- [Store control state in a database](/guides/durable-storage/): the only
  runtime that fills `RunSummary.cancellation` in.
