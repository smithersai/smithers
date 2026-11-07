# @smthrs/database

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact `4.1.1` peer dependency. Install one
`effect` release at that version so all Smithers packages share one Effect
runtime.

**Documentation:** https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/database/docs

One transaction boundary for SQL writes in an Effect application. Every write
goes through `DurableWriter.write`, which runs it inside a transaction, replays
it when the database reports a transient lock conflict, and normalizes whatever
comes back into five stable failure codes. Beside the writer, `Migrations`
composes the migration sets of several independent packages into one ordered
pass over one database.

The writer adds policy to writes only. Reads stay on Effect's own `SqlClient`
service, and the writer never wraps them.

## Install

```bash
npm install @smthrs/database@next effect
```

`effect` is a required peer at exactly `4.1.1`. The optional peer
`@effect/sql-sqlite-node` is required by `node/NodeDatabase` and
`test/TestDatabase`, including the example below. Install it at the same
version as your `effect`:

```sh
npm install @effect/sql-sqlite-node
```

PostgreSQL requires the optional `@effect/sql-pg` peer, at the same version as
your `effect`. The root installs no SQL adapter: `PostgresDatabase.layer` takes
the `@effect/sql-pg` module as its `driver`, so the root imports no socket code
and still bundles for browsers. Two
copies of `effect` in one tree split the `SqlClient` service identity and a
writer built against one copy cannot see a client provided from the other. The
Node driver needs Node.js 22.19.0 or later for its built-in `node:sqlite`
module.

## Write something through the boundary

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/sql/SqlClient"

const database = Layer.provideMerge(
  DurableWriter.layer(),
  NodeDatabase.layer({ filename: "flows.sqlite" })
)

const program = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const writer = yield* DurableWriter.DurableWriter
  return yield* writer.write(sql`SELECT 1 AS value`)
})

Effect.runPromise(program.pipe(Effect.provide(database), Effect.scoped)).then(console.log)
```

Two layers stack in a fixed order: the driver provides the client, and the
writer adds transaction policy over that client. `Layer.provideMerge` rather
than `Layer.provide`, so both services stay in the output. Add
`Migrations.layer(sets)` on top when your tables come from migration sets.

## Entry points

The root bundles for browsers. It carries the PostgreSQL adapter, whose
`@effect/sql-pg` driver the caller injects. The SQLite drivers are platform
specific and live at their own subpaths.

| Import                                       | Exports                                                                                                  |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `@smthrs/database`                           | `DurableWriter`, `Migrations`, `DatabaseMetrics`, `UnsupportedBackend`, `PostgresDatabase` as namespaces |
| `@smthrs/database/DurableWriter`             | the write boundary, its errors, and its layers                                                           |
| `@smthrs/database/Migrations`                | the migration composer                                                                                   |
| `@smthrs/database/DatabaseMetrics`           | the write-retry counter and the writer-lock wait timer                                                   |
| `@smthrs/database/UnsupportedBackend`        | the connection-string names this release ignores                                                         |
| `@smthrs/database/Dialect`                   | SQL fragments that read the same on SQLite and PostgreSQL                                                |
| `@smthrs/database/node/NodeDatabase`         | Node only. The `node:sqlite` client layer                                                                |
| `@smthrs/database/bun/BunDatabase`           | Bun only. The `bun:sqlite` client layer                                                                  |
| `@smthrs/database/postgres/PostgresDatabase` | The same module as the root's `PostgresDatabase`; import it from the root                                |
| `@smthrs/database/test/TestDatabase`         | Node only. The isolated test client and writer, and fixture helpers                                      |

`DurableWriter.make` accepts any Effect `SqlClient`, so the retry
classification and the error vocabulary are dialect blind. SQLite and PostgreSQL adapters share the stores and migration ladder. `PostgresDatabase`
works behind transaction-pooling proxies such as Cloudflare Hyperdrive and
PgBouncer. See [configuration and isolation](docs/concepts/sqlite-only.md).

## What the boundary buys you

- **A retry that replays only what replaying can fix.** A lock or
  serialization conflict is replayed on a bounded exponential backoff; a
  constraint violation never is, because that is the first writer winning.
- **One failure vocabulary.** `DatabaseError` carries `busy`, `constraint`,
  `io`, `schema`, `unsupported`, or `unknown`, and the same classifier decides both the
  code you are told and whether the write replayed.
- **An affected-row count that reads on any driver.** SQLite reports `changes`
  and node-postgres reports `rowCount`; `affectedRows` reads both and fails
  loudly when it can read neither.
- **Migration ids that cannot collide.** A `MigrationSet` names a package and
  reserves a block of 1000 ids, so a composed ladder stays ordered and every
  applied migration is recorded under its own name.

## Documentation

Full documentation is at [the package docs](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/database/docs):

- [Quickstart](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/database/docs/quickstart.md): the same program
  built one piece at a time, down to what the migration ledger holds.
- [The write boundary](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/database/docs/concepts/write-boundary.md):
  the serialization guarantee consumers depend on, savepoint nesting, and what
  replays.
- [The migration ladder](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/database/docs/concepts/migration-ladder.md):
  namespaces, id blocks, and the skip the loader refuses to perform.
- [API reference](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/database/docs/api.md): every public
  export.
- [Troubleshooting](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/database/docs/troubleshooting.md): the
  messages this package produces and what to change.

## License

MIT

## Runtime portability is a required contract

The engine and product flows are platform-independent Effect programs. Node and Bun
provide different SQL and host layers to the same runtime, migrations, journal,
stores, cache, and recovery logic. A Node subprocess is not a Bun compatibility
mechanism. Keep filesystem, process, crypto, HTTP and SQL access behind their
existing Effect services, selected at the executable's composition root.

`@smthrs/flows`' `Runtime` consumes an injected Effect `SqlClient` and host services.
`NodeRuntime` from `@smthrs/platform-node` and `BunRuntime` from
`@smthrs/platform-bun` select matching native services. Database adapters are `@smthrs/database/node/NodeDatabase` and
`@smthrs/database/bun/BunDatabase`; both share the schema guard, startup retry
policy and `DurableWriter`. Domain code must not open an extra database or create
its own command, job, event, or locking ledger around the durable engine.

Runtime parity must be demonstrated by the same execute, persist, restart, resume
and cancellation scenarios, including opening a Node-created database in Bun and
vice versa. A browser-safe import alone does not prove durable browser execution.

Test fixtures can use `TestSchemas.schemaName(prefix)` from the root export for an ASCII `<prefix>_<epoch-seconds>_<32 hex>` identity, at most 63 bytes. Hyphens in caller prefixes normalize to underscores before truncation; the generated name always matches the reaper’s exact pattern. A timestamped `SMITHERS_POSTGRES_SCHEMA` preserves that timestamp and random suffix when selecting each store, using its sanitized basename as the prefix (lowercase ASCII, at most 19 characters; other names are refused). Legacy configured prefixes keep their existing mapping. Repository Vitest bootstrap reaps only local fixtures older than two hours, skips locked relations, and bounds cleanup; scope finalizers still own normal teardown.
