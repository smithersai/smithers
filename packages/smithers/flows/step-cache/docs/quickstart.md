---
title: "Quickstart"
description: "Record a step result, read it back, watch the head move while the provenance ledger holds, refuse a stale entry, and evict one under a fence, all against an in-memory store."
sidebar:
  order: 2
---

This quickstart runs one whole cache cycle end to end. The store is the
production SQLite implementation over an in-memory database, so nothing here is
a stub and no file is written. By the end you will have recorded a result, read
it back two different ways, seen a bound refuse a stale row, and evicted a row
under a fence.

## Prerequisites

- Node.js 22.19.0 or later.
- A package that depends on `@smthrs/step-cache`, as
  [Installation](./installation.md) sets up.

## Record a result

Create `quickstart.ts`. A recording is one `CacheEntry`: the content digest,
the result, its metadata, when it was recorded, and the journal event that
recorded it.

```ts
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Effect from "effect/Effect"

const digest = "compile-server-v1"
const recordedAtMs = Date.now() - 60_000

const record = Effect.gen(function*() {
  const cache = yield* CacheStore.CacheStore
  const outcome = yield* cache.put({
    keyDigest: digest,
    result: { artifact: "dist/server.js" },
    meta: { durationMs: 1_820 },
    createdAtMs: recordedAtMs,
    recordedRunId: "run-a",
    recordedEventSeq: 7
  })
  return outcome._tag
})
```

`put` answers `Inserted` for a first write, `ExistingSame` when the store
already holds a result it does not disagree with, and `Conflict` when it holds
bytes it will not replace: the same provenance re-recorded with a different
`result`, `meta`, or `createdAtMs`, or a different `result` already under this
digest. Nothing overwrites: the first writer wins.

## Read it back, and watch the head move

One `put` writes two rows in one transaction: the mutable head that an ordinary
lookup serves, and an immutable ledger row keyed by `(keyDigest, recordedRunId,
recordedEventSeq)`. Evicting the head and recording a different result under a
new provenance moves what a plain lookup answers, and leaves the ledger row
exactly where it was:

```ts
import * as Option from "effect/Option"

const cycle = Effect.gen(function*() {
  const cache = yield* CacheStore.CacheStore

  // A second run records a different result under the same digest.
  yield* cache.evict(digest)
  yield* cache.put({
    keyDigest: digest,
    result: { artifact: "dist/server.mjs" },
    meta: { durationMs: 900 },
    createdAtMs: Date.now(),
    recordedRunId: "run-b",
    recordedEventSeq: 2
  })

  const head = yield* cache.get(digest)
  // The exact event `run-a` recorded still reads its own bytes.
  const recorded = yield* cache.get(digest, { recordedBy: { runId: "run-a", eventSeq: 7 } })

  return {
    head: Option.map(head, (entry) => entry.result),
    recorded: Option.map(recorded, (entry) => entry.result)
  }
})
```

That is the fence a replay reads through. An old frame's projection stays a
function of durable state, however the head has moved since.

## Refuse a stale entry

A caller that declared a time to live passes `maxAgeMs`. The store measures the
age from `createdAtMs` against the current clock reading and answers a miss
rather than a stale result:

```ts
const bounded = Effect.gen(function*() {
  const cache = yield* CacheStore.CacheStore
  const fresh = yield* cache.get(digest, {
    recordedBy: { runId: "run-a", eventSeq: 7 },
    maxAgeMs: 120_000
  })
  const stale = yield* cache.get(digest, {
    recordedBy: { runId: "run-a", eventSeq: 7 },
    maxAgeMs: 10_000
  })
  return { fresh: Option.isSome(fresh), stale: Option.isSome(stale) }
})
```

The bound is a read policy, never a deletion. The row is still on disk, so the
next caller declaring a longer bound still reads it. Removing rows is
`sweepExpired`, covered in [expire cached results](./guides/expire-cached-results.md).

## Evict only what you named

An eviction is a judgement about one row: this host observed this result to be
poison. Naming the provenance makes the delete a compare-and-swap, so a fresher
row another process recorded in the meantime is never dropped with it:

```ts
const evictions = Effect.gen(function*() {
  const cache = yield* CacheStore.CacheStore
  // `run-a` no longer owns the head, so its fence matches nothing.
  const stale = yield* cache.evict(digest, { ifRecordedBy: { runId: "run-a", eventSeq: 7 } })
  const current = yield* cache.evict(digest, { ifRecordedBy: { runId: "run-b", eventSeq: 2 } })
  return { stale, current }
})
```

## Run it

Provide the in-memory store and print each stage:

```ts
import * as TestCacheStore from "@smthrs/step-cache/test/TestCacheStore"

const main = Effect.gen(function*() {
  console.log("put:", yield* record)
  console.log("cycle:", yield* cycle)
  console.log("bounded:", yield* bounded)
  console.log("evictions:", yield* evictions)
})

Effect.runPromise(Effect.provide(main, TestCacheStore.layer).pipe(Effect.orDie))
```

Run the file with your TypeScript runner. The output is:

```text
put: Inserted
cycle: {
  head: { _id: 'Option', _tag: 'Some', value: { artifact: 'dist/server.mjs' } },
  recorded: { _id: 'Option', _tag: 'Some', value: { artifact: 'dist/server.js' } }
}
bounded: { fresh: true, stale: false }
evictions: { stale: false, current: true }
```

## What just happened

One digest carried two recordings. The head answered whichever result was
recorded most recently, and the ledger answered each event its own bytes. The
age bound refused a row it judged too old without deleting it, and the fenced
eviction deleted only the row whose provenance the caller named.

Two things this quickstart did not do belong to the composition around the
store, not to the store: deriving the digest, which is the
[content-addressing contract](/docs/concepts/content-addressing/), and deciding what a declared
`ttlMs` means, which is
[`@smthrs/engine-store`](/api/engine-store)'s to journal.

## Next steps

- [Compose a durable step cache](./guides/compose-a-store.md): the same store
  over a real SQLite file.
- [The head and the ledger](./concepts/head-and-ledger.md): why one `put`
  writes two rows, and what each one is for.
- [Share results across machines](./guides/share-results-across-machines.md):
  the same contract over HTTP, with a local tier in front of it.
