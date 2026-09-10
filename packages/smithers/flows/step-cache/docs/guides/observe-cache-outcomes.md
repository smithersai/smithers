---
title: "Observe cache outcomes"
description: "Read the hit, miss, and recording counters the step cache updates, find them in an exporter, read the spans each operation opens, and interpret a two-tier hit rate correctly."
sidebar:
  order: 7
---

The SQL store updates two counters as lookups and recordings resolve, and opens
one span per operation. Both are enough to answer the operational questions:
how often work is being reused, and whether a recording has ever been refused
because the store already held different bytes.

## The counters

| Metric                     | Attribute                  | Counts                                             |
| -------------------------- | -------------------------- | -------------------------------------------------- |
| `flows_step_cache_lookups` | `outcome: "hit"`           | A row existed and the caller's bounds accepted it  |
| `flows_step_cache_lookups` | `outcome: "miss"`          | No row, or a row a `maxAgeMs` bound refused        |
| `flows_step_cache_puts`    | `outcome: "inserted"`      | A recording created the head row                   |
| `flows_step_cache_puts`    | `outcome: "existing_same"` | A recording found a row that does not disagree     |
| `flows_step_cache_puts`    | `outcome: "conflict"`      | A recording was refused against bytes already held |

`CacheStoreMetrics` exports the attributed views to read: `hit`, `miss`, and
`put.Inserted`, `put.ExistingSame`, `put.Conflict`.

:::caution
The bare `lookups` and `puts` handles aggregate nothing and always read zero.
Every update this package makes carries an `outcome` attribute, so a dashboard
built on the unattributed handle shows a flat line. Read the views, or read the
metric name with its attribute in your exporter.
:::

## Get them into an exporter

This module defines the handles and nothing else. No exporter ships here.
Provide one, for example [`@smthrs/observability`](/api/observability), and the
counters appear in it under the names above. Nothing in the store needs
configuring: the metric updates happen whether or not anything is collecting
them.

## Read a counter in process

`Metric.value` answers the counter's state, and a test or a health check reads
`state.count`:

```ts
import * as CacheStoreMetrics from "@smthrs/step-cache/CacheStoreMetrics"
import * as Effect from "effect/Effect"
import * as Metric from "effect/Metric"

const count = (metric: Metric.Metric<number, Metric.CounterState<number>>) =>
  Effect.map(Metric.value(metric), (state) => state.count)

const hitRate = Effect.gen(function*() {
  const hits = yield* count(CacheStoreMetrics.hit)
  const misses = yield* count(CacheStoreMetrics.miss)
  return hits + misses === 0 ? 0 : hits / (hits + misses)
})
```

A test that wants an isolated tally provides its own registry with
`Effect.provideService(Metric.MetricRegistry, new Map())`, so counts from other
tests in the same process do not leak in. See
[test against the step cache](./test-with-the-cache.md).

## The spans

Every operation of every tier opens a span named for the method it implements,
so a trace shows which tier answered:

| Span                             | Annotations |
| -------------------------------- | ----------- |
| `CacheStore.get`, `put`, `evict` | `keyDigest` |
| `CacheStore.sweepExpired`        | `floorMs`   |
| `CombinedCacheStore.*`           | `keyDigest` |
| `RemoteCacheStore.*`             | `keyDigest` |

A remote lookup nests inside the combined one, so the shared tier's latency is
visible as its own child rather than folded into the local read.

## Interpreting a two-tier hit rate

`RemoteCacheStore` updates no counters. A lookup that `CombinedCacheStore`
serves from the shared tier therefore registers one `miss`, for the local tier
that did not hold it, plus the write-back's `Inserted`. The write-back makes
the next lookup a `hit`.

So on a machine with a shared tier, the hit rate measures how often this
machine already held the entry, not how often a result was reused. If you want
the second number, count it on the tier.

The composition adds one count of its own: when a shared `put` answers
`Conflict`, it records a `conflict`. That answer means the shared tier refused
to overwrite bytes it already holds under this digest, which on the head stage
is cross-host determinism divergence, and counting it is the only way an
operator sees it, because nothing else on that path returns, fails, or records
it.

:::note
That extra count assumes the shared tier keeps no counters, which is true of
`RemoteCacheStore`. Composing a second counter-keeping store as the shared tier
records the same conflict twice, once from that store's own `put` and once from
the composition.
:::

## Treat conflict as an alarm

`inserted` and `existing_same` are ordinary. A `conflict` is not: the store
refused to overwrite bytes it already held, either because one provenance was
re-recorded with a different `result`, `meta`, or `createdAtMs`, or because
another run recorded a different result for the same content digest. The first
is a defect in how a retry rebuilds its entry, the second a determinism defect
in a step or in the key derivation feeding it.
[Troubleshooting](../troubleshooting.md#a-recording-answers-conflict-and-you-expected-existingsame)
tells them apart. In a durable engine a `conflict` also routes to an
inconsistency receiver whose default verdict fails the run. Alert on the
counter moving at all, not on a rate.

## Where to go next

- [Local and shared tiers](../concepts/tiers.md): why the numbers read the way
  they do once there are two tiers.
- [The head and the ledger](../concepts/head-and-ledger.md): what makes a
  recording `Inserted`, `ExistingSame`, or `Conflict`.
