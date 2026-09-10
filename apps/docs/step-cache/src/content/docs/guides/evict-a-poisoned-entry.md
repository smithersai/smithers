---
title: "Evict a poisoned entry"
description: "Remove one recorded result so no later execution reuses it, fence the delete on the provenance you observed, and understand what eviction deliberately leaves behind."
sidebar:
  order: 4
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/step-cache/docs/guides/evict-a-poisoned-entry.md"
---

An eviction is a judgement about the future: this host observed this result to
be poison, so no later execution should reuse it. A stale read set, evidence
this host could not materialize, a result a downstream step proved wrong. The
verb is `evict`, and it answers whether a row was deleted.

## Fence the delete on the provenance you observed

Name the `(runId, eventSeq)` pair the entry you inspected was recorded by, and
the delete becomes a compare-and-swap:

```ts
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Effect from "effect/Effect"

const dropPoison = Effect.gen(function*() {
  const cache = yield* CacheStore.CacheStore
  return yield* cache.evict("compile-server-v1", {
    ifRecordedBy: { runId: "run-a", eventSeq: 7 }
  })
})
```

`true` means the row that carried that provenance is gone. `false` means
nothing matched, which is the answer whenever another process replaced the head
between your lookup and your eviction.

The predicate rides inside the `DELETE` statement rather than in a prior read.
A read-then-delete leaves a window in which a sibling process records a fresh
row under the same digest, and the unconditional delete drops that fresh row
along with the poison. Both halves of the pair are compared, because sequence
numbers are per run and collide across runs routinely.

## Delete unconditionally only when you own the digest

```ts
const dropEverything = Effect.gen(function*() {
  const cache = yield* CacheStore.CacheStore
  return yield* cache.evict("compile-server-v1")
})
```

Omitting the predicate deletes whatever head row is there. That is right for a
tool clearing a cache file it owns, and wrong for a running engine, where the
row you meant to drop may no longer be the row you delete.

## The head carries the first writer's provenance

`put` never overwrites a head row. A second run recording the same result under
its own provenance answers `ExistingSame` and leaves the row, including its
`recordedRunId` and `recordedEventSeq`, exactly as the first writer wrote it.
So fence on the provenance the entry you read reported, not on the provenance
of the run doing the eviction. Read it off the entry:

```ts
import * as Option from "effect/Option"

const dropWhatIRead = Effect.gen(function*() {
  const cache = yield* CacheStore.CacheStore
  const found = yield* cache.get("compile-server-v1")
  if (Option.isNone(found)) return false
  const entry = found.value
  return yield* cache.evict(entry.keyDigest, {
    ifRecordedBy: { runId: entry.recordedRunId, eventSeq: entry.recordedEventSeq }
  })
})
```

## What eviction leaves behind

The append-only ledger row. `evict` removes the reusable head and nothing else,
so a replay that reads through
[the provenance fence](/guides/read-a-recorded-result/) still reads the bytes its
own event recorded, poison included. That is the point:
[the head and the ledger](/concepts/head-and-ledger/) explains why a past
run's projection must stay a function of what that run recorded.

Two consequences follow for the digest you just evicted.

- A later `put` under the same provenance and the same bytes restores the head
  and answers `Inserted`. The ledger row that survived the eviction is the
  authority, and it agrees.
- A later `put` under the same provenance and different bytes answers
  `Conflict`, and no head row is created. Different bytes means any of
  `result`, `meta`, or `createdAtMs`, so re-recording with a fresh clock
  reading conflicts inside one run. The immutable record cannot be rewritten,
  so an eviction can never be used to launder a divergent result into the
  cache.

## A malformed fence is a caller mistake

A fence naming an empty run id, a fractional sequence number, or a negative one
is a compare-and-swap no row could satisfy. `evict` fails with `invalid_cache`
before any `DELETE` is issued rather than reporting the mistake as an ordinary
"nothing matched". `CacheStore.validateFence` is the same check, exported for
an adapter that implements this contract elsewhere.

## Against a shared tier

`CombinedCacheStore.evict` never reaches across. One host's observation that a
result is poison does not generalize to a tier where another machine may still
hold the artifacts this one lost, so reclaiming shared entries is an explicit
retention operation on the tier that owns them. See
[local and shared tiers](/concepts/tiers/).

`RemoteCacheStore.evict`, composed directly, sends `DELETE /ac/{keyDigest}` and
carries the fence as the `recordedRunId` and `recordedEventSeq` query
parameters. A 2xx answer is `true` and `404` is `false`.

:::danger
Against a tier that ignores query parameters, a fenced eviction degrades to an
unconditional `DELETE`, which is the poison-drop the fence exists to prevent.
The client cannot detect it. Fenced evictions need a conforming server: see
[implement a shared cache server](/guides/implement-a-shared-tier/).
:::

## Where to go next

- [Expire cached results](/guides/expire-cached-results/): reclaiming a whole age
  band rather than one named row.
- [The head and the ledger](/concepts/head-and-ledger/): how reference-aware
  retention collects ledger rows.
