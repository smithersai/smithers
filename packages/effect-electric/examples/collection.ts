import { TestSchemas } from "@smthrs/database"
/**
 * An Electric collection of todos synced from Postgres: rows decoded by a
 * schema, an `onInsert` that writes the row and waits for Electric to deliver
 * its transaction, and the shape's sync status as a stream.
 *
 * It writes straight to Postgres to stay short; an app writes through its own
 * server, which answers with the transaction id. Run it with
 * `node examples/collection.ts` against a Postgres with logical replication and
 * Electric: it reads `DATABASE_URL` and `ELECTRIC_URL`, creates a scratch
 * schema, and drops it when it ends.
 */
import { PgClient } from "@effect/sql-pg"
import { ElectricCollection } from "@smthrs/effect-electric"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/sql/SqlClient"
import * as Stream from "effect/Stream"

/** A todo, as Postgres stores it and Electric delivers it. */
export const Todo = Schema.Struct({ id: Schema.String, title: Schema.String, done: Schema.Boolean })
export type Todo = typeof Todo.Type

/** A `todos` table in a schema of its own, dropped with the schema when the scope closes. Returns its name. */
export const scratchTodos = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const schema = TestSchemas.schemaName("todos_example")
  yield* Effect.acquireRelease(
    sql.unsafe(`create schema ${schema}`).pipe(
      Effect.andThen(
        sql.unsafe(`create table ${schema}.todos (id text primary key, title text not null, done boolean not null)`)
      )
    ),
    () => sql.unsafe(`drop schema ${schema} cascade`).pipe(Effect.orDie)
  )
  return `${schema}.todos`
})

/**
 * Syncs `table` from Electric at `electricUrl`, inserts a todo, and returns
 * whether it came back as the source has it, the rows, and the sync events
 * seen until then.
 */
export const program = (electricUrl: string, table: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const todos = yield* ElectricCollection.make({
      id: `todos-${table}`,
      schema: Todo,
      getKey: (todo) => todo.id,
      shape: { url: `${electricUrl}/v1/shape`, params: { table } },
      // Runs with the services of the fiber that made the collection: here, its SqlClient.
      onInsert: ({ rows, collection }) =>
        Effect.gen(function*() {
          const [written] = yield* sql<{ readonly txid: string }>`
            insert into ${sql(table)} ${sql.insert([...rows])}
            returning pg_current_xact_id()::xid::text as txid`
          yield* collection.awaitTxId(Number(written!.txid), "10 seconds")
        })
    })
    const events: Array<ElectricCollection.SyncEvent["_tag"]> = []
    yield* todos.sync.pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event._tag))),
      Effect.forkScoped({ startImmediately: true })
    )
    yield* todos.preload
    const transaction = yield* todos.insert({ id: "1", title: "Write the docs", done: false })
    yield* transaction.persisted
    return {
      synced: yield* todos.isSynced("1"),
      rows: (yield* todos.toArray).map(({ id, title, done }) => ({ id, title, done })),
      events: [...events]
    }
  })

if (import.meta.main) {
  const database = process.env.DATABASE_URL ?? "postgresql://smithers:smithers@localhost:54321/smithers"
  const electric = process.env.ELECTRIC_URL ?? "http://localhost:30001"
  const result = await Effect.runPromise(
    Effect.scoped(Effect.flatMap(scratchTodos, (table) => program(electric, table))).pipe(
      Effect.provide(PgClient.layer({ url: Redacted.make(database) }))
    )
  )
  console.log(result)
}
