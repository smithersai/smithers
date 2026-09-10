# @smthrs/step-cache

This package declares `effect` as an exact
`4.0.0-rc.112` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://step-cache.smithers.sh

Content-addressed storage for finished step results. Record a result under a
digest of its inputs, and the next run that computes the same digest reads the
result instead of doing the work again.

One `put` writes two rows. The **head** is the mutable row an ordinary lookup
serves: evict it, sweep it when it ages out, and it is allowed to disappear.
The **ledger** row is keyed by the run and journal event that recorded the
result, and no verb in this package deletes one, so a replay reading through
that fence still sees the bytes its own event recorded.

## Install

`@smthrs/step-cache` is not on npm at 1.0.0-rc.0. It ships as a member of the
[smithers repository](https://github.com/smithersai/smithers) workspace, so
using it today means working from a checkout:

```bash
git clone https://github.com/smithersai/smithers.git
cd smithers
pnpm install
```

Code that consumes it lives in that workspace and depends on it with a
workspace specifier:

```json
{
  "dependencies": {
    "@smthrs/step-cache": "workspace:*"
  }
}
```

It needs Node.js 22.19.0 or later and `effect` 4.0.0-rc.112. The import forms
and the driver layers a durable composition adds are on the
[installation page](https://step-cache.smithers.sh/installation/).

## Reuse a result instead of recomputing it

`TestCacheStore` is the production SQLite store over an in-memory database, so
this runs with no file and no setup:

```ts
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as TestCacheStore from "@smthrs/step-cache/test/TestCacheStore"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"

const compileOnce = (digest: string) =>
  Effect.gen(function*() {
    const cache = yield* CacheStore.CacheStore

    const hit = yield* cache.get(digest)
    if (Option.isSome(hit)) return { from: "cache", result: hit.value.result }

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
  console.log((yield* compileOnce("compile-server-v1")).from)
  console.log((yield* compileOnce("compile-server-v1")).from)
})

Effect.runPromise(Effect.provide(main, TestCacheStore.layer).pipe(Effect.orDie))
```

```text
work
cache
```

Swap `TestCacheStore.layer` for `CacheStore.layer` over a real database and the
same program keeps its results across restarts. The digest is the caller's to
compute: this store receives one and never inspects what it names.

## What it does that a dictionary does not

- **Recording is first-writer-wins.** `put` answers `Inserted`,
  `ExistingSame`, or `Conflict`, and never silently replaces a result two
  callers disagree about. `Conflict` means the store refuses to overwrite bytes
  it already holds: one provenance re-recorded with a different `result`,
  `meta`, or `createdAtMs`, or another run recording a different `result` under
  the same digest.
- **Reuse is revocable and replay is not.** `evict` takes the head under a
  fenced compare-and-swap, and leaves the immutable ledger row a past run
  replays from.
- **Every argument crosses a strict admission boundary.** Entry fields and
  remote construction options are detached and frozen without invoking a getter
  or a `toJSON` hook. Accessors, cycles, non-JSON values, ill-formed Unicode,
  and trees past the 4 MiB budget are refused before a statement is issued.
  Lookup and eviction selectors are schema-decoded once instead, so a
  caller-owned accessor runs at most one time and the operation reads only the
  decoded copy.
- **Results are stored verbatim.** A hit is handed back to a step as its own
  value, so nothing here redacts or coerces what it stores.
- **Another machine's work is reusable.** `RemoteCacheStore` speaks the
  action-cache half of Bazel's dumb-HTTP remote cache protocol, and
  `CombinedCacheStore` puts it behind the local store with read-through and
  write-back.

## Public API

The root entry point exports these namespaces, and each is also importable from
`@smthrs/step-cache/<Module>`. Every export, with its signature and its
guarantees, is on the
[API reference](https://step-cache.smithers.sh/reference/api/).

| Namespace            | What it is                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `CacheStore`         | The service contract and its SQL implementation, with the schemas, limits, and validators it admits by. |
| `CacheStoreMetrics`  | Hit, miss, recording-outcome, and degraded shared-tier operation counters.                              |
| `CombinedCacheStore` | Local-first read-through, local write-back, and inline or deferred remote publication.                  |
| `RemoteCacheStore`   | The HTTP client for a shared tier, bounded, under `/ac/{keyDigest}`.                                    |
| `Migrations`         | The namespaced migration set that creates the two tables.                                               |

The root names no database driver, so it bundles for the browser. Only
`@smthrs/step-cache/test/TestCacheStore`, the migrated in-memory store for
tests, binds Node SQLite, which is why it lives at its own subpath.

The shared tier is an accelerator, not a run dependency. A refused remote
lookup degrades to a miss, and a refused inline publication preserves the
local `put` outcome. Both increment `flows_step_cache_remote_failures` with an
`operation` of `get` or `put`.

## Documentation

- [Overview](https://step-cache.smithers.sh)
- [Quickstart](https://step-cache.smithers.sh/quickstart/)
- [The head and the ledger](https://step-cache.smithers.sh/concepts/head-and-ledger/)
- [What the cache admits](https://step-cache.smithers.sh/concepts/admission/)
- [Share results across machines](https://step-cache.smithers.sh/guides/share-results-across-machines/)
- [Troubleshooting](https://step-cache.smithers.sh/troubleshooting/), which
  lists every failure message, what causes it, and what to change.

## License

MIT. See [LICENSE](./LICENSE).
