# `@smthrs/effect-electric`

Electric for Effect programs. An Electric collection is a TanStack DB
collection synced from a Postgres shape, built on
[`@smthrs/effect-tanstack-db`](../effect-tanstack-db/README.md): scoped, its
rows decoded by an Effect `Schema`, its mutation handlers Effects that share
your program's services. It retries failed requests on an Effect `Schedule`,
reports its sync status as a `Stream`, and waits for a write by transaction id
or by match. With `persist`, it keeps its rows and Electric's resume state on
the device, so the next program shows them before the network answers and
resumes the shape where it stopped. For the server, `ShapeProxy` serves a browser's shape requests from
your own route, with the table, the allowed parameters and Electric's secret
chosen there.

The package will move to its own repository as an open-source library; its
proposed npm name is `effect-electric`.

**Documentation:** [`docs/`](docs/README.md)

## Install

The package is private in this repository. Add it as a workspace dependency,
with its peer dependencies at these exact versions. It depends on
`@smthrs/effect-tanstack-db`, which comes with it.

```json
{
  "dependencies": {
    "@smthrs/effect-electric": "workspace:*",
    "@electric-sql/client": "1.5.28",
    "@tanstack/db": "0.15.1",
    "@tanstack/electric-db-collection": "0.6.2",
    "effect": "4.0.5"
  }
}
```

To use `persist`, add `@tanstack/db-sqlite-persistence-core` 0.4.11 and a
host's persistence package, such as `@tanstack/browser-db-sqlite-persistence`
0.2.36. The versions are exact because the package is tested against them. It
imports no Node built-in, so it runs in a browser, a Worker, Node and Bun.

## Quickstart

```ts
import { ElectricCollection } from "@smthrs/effect-electric"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

const Todo = Schema.Struct({ id: Schema.String, title: Schema.String, done: Schema.Boolean })

const program = Effect.scoped(Effect.gen(function*() {
  const todos = yield* ElectricCollection.make({
    id: "todos",
    schema: Todo,
    getKey: (todo) => todo.id,
    shape: { url: "https://example.com/api/shapes/todos" }
  })
  yield* todos.sync.pipe(
    Stream.runForEach((event) => Effect.log(`sync: ${event._tag}`)),
    Effect.forkScoped({ startImmediately: true })
  )
  yield* todos.preload
  return yield* todos.toArray
}))
```

[`examples/collection.ts`](examples/collection.ts) adds an `onInsert` that
writes the row and waits for its transaction, and runs with
`node examples/collection.ts` against a Postgres and Electric.
[`examples/proxy.ts`](examples/proxy.ts) mounts the shape proxy.

## Testing

`pnpm exec smthrs test '//packages/effect-electric:test'` starts isolated
Postgres and Electric containers with Docker Compose when the default local stack
is absent, runs the complete coverage suite, then removes its containers and
volumes. To supply other services, run `node scripts/test-services.mjs` with both
`DATABASE_URL` and `ELECTRIC_URL`. Required services failing to start or answer
fail the target; its integration cases never silently skip.

The Node SQLite fixture uses separate connections to each test's own file, with
real Web Locks held through `COMMIT`, `ROLLBACK` or close and synchronous batches.
This matches the browser's `SharedSqlite` transaction ownership: another tab waits
without blocking the owner. An async wrapper around synchronous `node:sqlite`
alone cannot provide that contract; competing `BEGIN IMMEDIATE` calls fail with
`SQLITE_BUSY` before the owning connection can resume. Fixture regressions and
production sources both run under the 100% coverage gate.

## Learn more

- [Overview](docs/README.md): what the package guarantees.
- [API reference](docs/api.md): every export.
- [The sync policy](docs/sync-policy.md): retries, `reconnect`, and what the
  sync status means for a UI.
- [Proxy shapes through your server](docs/shape-proxy.md).

When a host embeds independent browser realms in one JavaScript realm (for example Node integration fixtures),
provide a distinct `ShapeSource.Source.cacheNamespace` for each realm. Electric's module-level replay caches use
separate keys; every collection of that source shares the namespace. It never reaches the server, and does not
change the application's origin. `layerFaulty` retains the wrapped source's namespace, including when it refuses
a request. Ordinary browser tabs use the default source without a namespace.

`ShapeProxy.make` accepts `rowAccess: { keyColumns, allows }` for a stable authorization projection whose older log entries may outlive a current access decision. After buffering a JSON response it runs optional `validate` once to prepare current authority, then calls `allows` for each insert/update value. It drops disallowed values, reduces deletes to primary keys, and preserves controls and cursor headers. Missing keys or invalid JSON fail closed with 502. Pair it with a database projection that removes inaccessible rows and inserts them again on recovery; dropping values alone cannot replay missed changes. Hosts can provide `retryIfDenied(value)` when a filtered value remains stored without a guaranteed replay transition; the proxy then returns 503 without consuming its cursor. This mode buffers each finite JSON long poll and refuses SSE with 503. Other proxies continue streaming unchanged.
