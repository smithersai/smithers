---
title: "Read scores back"
description: "Query one target's observations with limit, offset, and a time filter, walk a history longer than one page, and read the aggregate that reports its inconclusive denominator."
sidebar:
  order: 5
---

`ScoreStore` has two read entry points: `observations` returns rows, and
`aggregate` returns four numbers over them. Both take a target step key and an
optional scorer key.

## Read one page

```ts
import { ScoreStore } from "@smthrs/scorers"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const store = yield* ScoreStore.ScoreStore
  return yield* store.observations("greet/ada", contains.scorerKey, { limit: 100, offset: 0 })
})
```

Rows come back ordered by `(at, insertion)`, oldest first, with the insertion
id breaking ties inside one millisecond. Omit the scorer key to read every
scorer's observations for that target.

Reads are always bounded. `limit` defaults to and may not exceed
`ScoreStore.maxObservations` (1,000). Every bound must be a safe integer in
range, or the call fails with code `invalid_request` naming the value it was
given:

```text
An observation page limit must be an integer in [1, 1000], received 5000
```

Filtering by scorer key is served by the `(target_step_key, scorer_key, at_ms)`
index. A read across every scorer sorts instead, because the index's second
column is the scorer key. Pass the scorer key when you have it.

## Walk a longer history

`offset` is the cursor. `(at, insertion)` is a total order, so stepping
`offset` by `limit` reaches every row, including rows that share one
millisecond:

```ts
const everyObservation = (targetStepKey: string, scorerKey: string) =>
  Effect.gen(function*() {
    const store = yield* ScoreStore.ScoreStore
    const found: Array<ScoreStore.Observation> = []
    const limit = 500
    for (let offset = 0;; offset += limit) {
      const page = yield* store.observations(targetStepKey, scorerKey, { limit, offset })
      found.push(...page)
      if (page.length < limit) return found
    }
  })
```

`before` is a filter, not a cursor: an exclusive upper bound on `at` that
narrows the query to observations recorded before an instant. It walks nothing
on its own. Paging with `before` alone would stop at a page of rows sharing the
last timestamp and leave the rest of that millisecond permanently unreachable.
Combine `before` with `offset` when you want both a window and a walk.

## Aggregate a target

```ts
const summary = Effect.gen(function*() {
  const store = yield* ScoreStore.ScoreStore
  return yield* store.aggregate("greet/ada", contains.scorerKey)
})
```

The result is `{ count, mean, min, inconclusive }`, or `undefined` when the
target has no observations of either kind:

```text
{ count: 3, mean: 0.6666666666666666, min: 0, inconclusive: 0 }
```

`count`, `mean`, and `min` describe successful scores only. `mean` and `min`
are `undefined` when `count` is zero. `inconclusive` counts the attempts that
produced no score, and it is the number that makes the mean readable: without
it, a target scored a hundred times where ninety-nine attempts failed reports
exactly what a target scored once, cleanly, reports.

## When a read fails

A read decodes every row against the same contract the write path enforces, and
names the row id when one does not match:

```text
Stored observation 41 does not match the durable observation contract
```

That failure means the database was written by something other than this store,
by a hand-written `INSERT` or a direct edit. The row id is there so you can find
it. The rules a row must satisfy are listed in
[Durability](../durability.md#what-the-store-refuses-to-persist).

## Next

- [Observations](../concepts/observations.md): what each kind of row means.
- [Durability](../durability.md): how to prune old observations and job claims.
