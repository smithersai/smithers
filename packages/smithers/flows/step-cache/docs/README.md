---
title: "@smthrs/step-cache"
description: "Content-addressed storage for finished step results: record a result under a digest of its inputs, reuse it on the next run, and keep an immutable record of which run produced it."
---

`@smthrs/step-cache` records the result of a finished step under a digest of
its inputs, so the next run that computes the same digest reads the result
instead of doing the work again. It is an [Effect](https://effect.website)
service with three implementations: a durable SQL store, an HTTP client for a
cache other machines share, and a two-tier composition of the two.

## The problem it solves

A long job that crashes, retries, or reruns on a fresh checkout starts over.
The steps that already produced an answer should not be paid for twice: a
compile that took 90 seconds, a model call that cost money, a test suite that
already passed on exactly these inputs.

Memoizing that is a dictionary lookup until two requirements collide. Reuse has
to be revocable, because a result can turn out to be poison and no later run
should reuse it. Replay has to be stable, because a run that finished last
Tuesday must keep reporting what it actually recorded, whatever has been
evicted since.

This package answers both by writing two rows for every recording, in one
transaction:

- The **head** is the mutable row an ordinary lookup serves. Evict it, sweep it
  when it ages out, or overwrite what it points at. It is a cache, and it is
  allowed to disappear.
- The **ledger** row is keyed by the run and journal event that recorded the
  result. A replay reading through that fence sees the bytes its own event
  recorded, even after the head has moved on. Optional reference-aware
  retention collects old evidence only after local references are released.

Recording is first-writer-wins: `put` answers `Inserted`, `ExistingSame`, or
`Conflict`, and never silently replaces bytes it already holds. `Conflict`
covers both refusals: one provenance re-recorded with different bytes, and a
different `result` recorded under one digest by another run. Every argument
crosses a strict admission boundary first, because a hit is handed back to a
caller as real executable state.

## Get the package

`@smthrs/step-cache` is not on npm at 1.0.0-rc.0. It ships as a member of the
[smithers repository](https://github.com/smithersai/smithers) workspace, so
using it today means working from a checkout.
[Installation](./installation.md) has the clone, the workspace specifier, and
the runtime requirements.

## Reuse a result instead of recomputing it

This program runs the expensive work once, records it, and reads it back on the
second call. `TestCacheStore` is the production SQL store over an in-memory
database, so the example runs with no file and no setup:

```ts
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as TestCacheStore from "@smthrs/step-cache/test/TestCacheStore"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"

const compileOnce = (digest: string) =>
  Effect.gen(function*() {
    const cache = yield* CacheStore.CacheStore

    const hit = yield* cache.get(digest)
    if (Option.isSome(hit)) {
      return { from: "cache", result: hit.value.result }
    }

    const result = { artifact: "dist/server.js", bytes: 41_022 }
    yield* cache.put({
      keyDigest: digest,
      result,
      meta: { durationMs: 1_820 },
      createdAtMs: Date.now(),
      recordedRunId: "run-a",
      recordedEventSeq: 7
    })
    return { from: "work", result }
  })

const main = Effect.gen(function*() {
  const first = yield* compileOnce("compile-server-v1")
  const second = yield* compileOnce("compile-server-v1")
  console.log(first.from, JSON.stringify(first.result))
  console.log(second.from, JSON.stringify(second.result))
})

Effect.runPromise(Effect.provide(main, TestCacheStore.layer).pipe(Effect.orDie))
```

```text
work {"artifact":"dist/server.js","bytes":41022}
cache {"artifact":"dist/server.js","bytes":41022}
```

Swap `TestCacheStore.layer` for `CacheStore.layer` over a real database and the
same program keeps its results across restarts. [Compose a durable step cache](./guides/compose-a-store.md) wires that composition.

The digest is the caller's to compute. This store receives one and never
inspects what it names, which is what lets any producer of stable content keys
use it.

## How this fits the Smithers engine

This package is one seam of the Smithers durable flow engine, and most people
reach it through the engine rather than directly.
[`@smthrs/flows`](/api/flows) is the single dependency that carries that whole
engine: it re-exports this package as its `StepCache` namespace, and its
`NodeRuntime` composes `CacheStore.layer` into a durable host, so a flow author
gets step reuse without ever naming this package. Above that sits the
[`smithers` command line](/api/cli), which runs and resumes those flows from a
terminal.

Depend on `@smthrs/step-cache` on its own when you want the store without the
engine: memoizing your own pipeline, standing up a shared cache for a fleet, or
composing a host by hand.

## Next steps

- [Installation](./installation.md): import forms, runtime requirements, and
  what a runnable composition adds.
- [Quickstart](./quickstart.md): one whole cache cycle, including the age bound
  and a fenced eviction.
- [The head and the ledger](./concepts/head-and-ledger.md): why one `put`
  writes two rows.
- [What the cache admits](./concepts/admission.md): the key grammar and the
  bounded JSON budget every argument crosses.
- [Local and shared tiers](./concepts/tiers.md): read-through, write-back, and
  what a shared tier changes.
- [Share results across machines](./guides/share-results-across-machines.md):
  the same contract over HTTP.
- [API reference](./api.md): every public export.
- [Troubleshooting](./troubleshooting.md): what each `CacheStoreError.code`
  means and what to do about it.
