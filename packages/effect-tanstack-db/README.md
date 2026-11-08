# `@smthrs/effect-tanstack-db`

TanStack DB for Effect programs. A collection is a scoped service whose rows an
Effect `Schema` checks, its reads and mutations are Effects with typed errors,
and its changes and live query results are `Stream`s. The TanStack DB
collection stays available for framework bindings such as `@tanstack/react-db`,
so a view layer renders the same live queries the Effect program writes to.
`Persistence` keeps a collection's rows on the device in SQLite, and `Outbox`
stores writes durably and sends them until they succeed or are refused, or
until the program takes one back before it is sent. `Migrations` carries both
across builds: each store declares its versions, and each build brings what an
older one stored to its own before anything reads it.

The package will move to its own repository as an open-source library; its
proposed npm name is `effect-tanstack-db`.

**Documentation:** [`docs/`](docs/README.md)

## Install

The package is private in this repository. Add it as a workspace dependency,
with its peer dependencies at these exact versions:

```json
{
  "dependencies": {
    "@smthrs/effect-tanstack-db": "workspace:*",
    "@tanstack/db": "0.15.1",
    "@tanstack/db-sqlite-persistence-core": "0.4.11",
    "effect": "4.1.1"
  }
}
```

Add `@tanstack/offline-transactions` 1.1.3 to use `Outbox`, and a host's
persistence package, such as `@tanstack/browser-db-sqlite-persistence`
0.2.36, to use `Persistence`. The package imports no Node built-in and takes
every host capability as an argument, so it runs in a browser, a Worker, Node
and Bun.

## Quickstart

```ts
import { Collection, LiveQuery, Query } from "@smthrs/effect-tanstack-db"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const Todo = Schema.Struct({ id: Schema.String, title: Schema.String, done: Schema.Boolean })

const program = Effect.scoped(Effect.gen(function*() {
  const todos = yield* Collection.local({ id: "todos", schema: Todo, getKey: (todo) => todo.id })
  const open = yield* LiveQuery.make((q) =>
    q.from({ todo: todos.tanstack }).where(({ todo }) => Query.eq(todo.done, false))
  )
  yield* open.preload
  yield* todos.insert({ id: "1", title: "Write the docs", done: false })
  yield* todos.update("1", (todo) => {
    todo.done = true
  })
  return yield* open.toArray
}))

console.log(await Effect.runPromise(program)) // []
```

When the scope closes, the collection and the live query are cleaned up.
[`examples/quickstart.ts`](examples/quickstart.ts) is a fuller version that runs
with `node examples/quickstart.ts`.

## Learn more

- [Overview](docs/README.md): what the package guarantees, and how it fits a
  sync adapter.
- [API reference](docs/api.md): every export, `Persistence`, `Outbox` and
  `Migrations` included.
- [Migrations](docs/migrations.md): declaring each store's versions, bringing
  a device forward on every deploy, and the lock that fails a test on a schema
  change without a version.
- [Frameworks](docs/frameworks.md): rendering live queries with React or
  another binding.
