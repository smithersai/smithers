---
title: "Defer work with selection beliefs"
description: "Record suspected edges, let the scheduler postpone sink nodes a change probably does not affect, then repay that debt with a guess-free recertification pass."
sidebar:
  order: 9
---

Selection is the one advisory seam in this package. It guesses which sink nodes
a change probably does not affect and postpones them, and it proposes flows a
plan never reaches. It never changes a step key, a cache row, or a correctness
decision, and the default admits everything.

## The belief shape

A `SuspectedEdge` says "changes matching this path pattern tend to affect this
flow":

```ts
import { Selection } from "@smthrs/engine-store"

const edge: Selection.SuspectedEdge = {
  scope: "packages/ui/src/**",
  affects: "flows/IntegrationTests",
  confidence: 0.8,
  validFromMs: 0,
  evidence: ["run-42:seq-118"]
}
```

`confidence` is in `[0, 1]` and is moved by outcomes, never by hand.
`validFromMs` keeps the edge inert until a snapshot's `pinnedAtMs` reaches it.
`evidence` references the journal facts the guess was learned from.

A `BeliefSnapshot` pins the edge set at plan time, which is what keeps selection
a pure function of data in hand: a belief updated mid-run cannot change what
that run defers.

## Persist and train the beliefs

```ts
import { SelectionStore } from "@smthrs/engine-store"
import * as Effect from "effect/Effect"

const train = Effect.gen(function*() {
  const store = yield* SelectionStore.SelectionStore
  yield* store.upsert([edge])
  const snapshot = yield* store.snapshot()
  yield* store.train([{ scope: edge.scope, affects: edge.affects, outcome: "miss" }])
  return snapshot
})
```

`SelectionStore.layer` persists through this package's own migration set and
needs `DurableWriter` and `SqlClient`.

- `upsert(edges)` inserts or replaces by `(scope, affects)`. It refuses an
  edge whose scope breaks the scope grammar with `invalid_input`.
- `list()` returns every stored edge, and fails with `decode_failed` on a row
  that no longer decodes, including a scope stored before the wildcard cap.
- `snapshot()` returns a `BeliefSnapshot` pinned at the injected clock's current
  time, never `Date.now()`.
- `train(observations)` applies the asymmetric rule in one transaction: a hit
  gains five percent of the remaining headroom, `confidence + 0.05 * (1 -
  confidence)`; a miss halves, `confidence * 0.5`. Training only touches
  matching stored edges, ignores unknown pairs rather than creating them, and
  never writes journal records. At most `maxEvidenceEntries` (128) newest
  evidence entries are retained per edge.

`SelectionStoreError` distinguishes `invalid_input`, `decode_failed` for a
corrupt row, and `persistence_failed`.

## Wire selection into a scheduler run

`PlanScheduler.Options.selection` carries the whole opt-in, and every field is
optional because every default is inert:

```ts
const scheduler = PlanScheduler.layer({
  runId: "plan-1",
  owner,
  sourceId: "planner",
  selection: {
    changed: ["packages/ui/src/Button.tsx"],
    beliefs: snapshot,
    policy: { deferBelow: 0.3 }
  }
})
```

`deferBelow` defaults to zero, which defers nothing. A sink whose best matched
likelihood is strictly below the threshold is deferred; a likelihood exactly at
the threshold is admitted. `full: true` is the run-level override: every verdict
is treated as `Admit` and the override is journaled, the way a `--fresh` flag
ignores the cache.

## Choose a selector

`Selection.layerNoop` admits everything, and is the behavioral default: a run
under it is byte-identical to a run before the seam existed.

`Selection.layerHeuristic` is pure glob matching over live edges, where live
means `validFromMs <= pinnedAtMs`. A scope glob must match the whole path:
`**` matches any run of characters including `/`, `*` matches a run within one
segment, `?` matches one non-`/` character, and every other character is
literal. A scope carries at most `Selection.maxScopeWildcards` (8) `*` or `**`
tokens. Matching runs in time linear in the path and never backtracks. A matching edge supplies the likelihood, a
sink can defer only when a live edge names it, and a `Candidate.stats` failure
ratio raises the likelihood so flaky sinks stay inline. Stats alone never defer.

`Selection.layer(service)` installs your own. A model-backed layer belongs
elsewhere, because `@smthrs/engine-store` carries no model dependency.

A selector returns one `Selected` per candidate carrying a `Verdict`:

| Verdict   | Meaning                                                                                       |
| --------- | --------------------------------------------------------------------------------------------- |
| `Admit`   | Run the node normally.                                                                        |
| `Defer`   | Postpone the sink; carries the `edge` and the `likelihood`.                                   |
| `Propose` | Name a flow no real dependency reaches; carries the `flow`, the `edge`, and the `confidence`. |

Only sink nodes, plan nodes nothing depends on, are offered as candidates.

## Read and repay the debt

A deferred node is journaled as `flows.engine.selection-deferred` and settles
`deferred`. It never dispatched, wrote no cache row, and is never reported as
passed.

```ts
const owed = Selection.debt("plan-1")
```

`debt(runId)` folds the journal: each `selection-deferred` record opens a debt
under its plan key, and a later `node-settled` under the same key with `built`,
`clean`, or `failed` closes it. A `skipped` settlement does not, because that
work never ran. A `failed` one does, because the guess-free pass executed the
work and surfaced the miss, which is the training signal.

`debt(runId, { repaidBy })` widens only the close side, accepting matching
settlements from explicitly named repaying runs. The fold never guesses which
other runs were guess-free passes.

`PlanScheduler.recertify({ plan, deferringRunId, options })` is the driver:
it re-drives the compiled plan under the caller's fresh run id with the `full`
selection override, then returns `{ runId, report, remaining }`, where
`remaining` is the deferring run's debt computed with `repaidBy`. Repayment is a
read-side join; the deferring run's journal is never rewritten.

Scheduling the cadence, nightly or per merge, is a product concern. This is the
primitive one pass runs.

## Present it

Three pure helpers render selection without any IO:

- `Selection.risk({ changed, beliefs })` returns `{ level, reasons }`, where
  level is `high` at confidence at or above 0.7, `medium` at or above 0.4, else
  `low`, and each reason reads `<scope> -> <affects> (<confidence>)`. It is an
  annotation, never a gate.
- `Selection.card(input)` renders the plan card, one string per line: `clean`
  renders as `cached`, `built` as `run`, a `deferred` row carries its fail
  likelihood and the recertification cadence, and each proposal names the edge
  that suggested it.
- `Selection.proposeReadSet({ beliefs, flow, paths })` returns the workspace
  paths live edges select for a flow, deduplicated in input order. It is the
  feeder for a `boundaryMode: "expected"` declaration.

## Related

- [Drive a plan to completion](./drive-a-plan.md): where the `deferred` outcome
  appears.
