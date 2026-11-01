/**
 * A parent that re-executes a child it already admitted records the same
 * parent edge again, inside the child's partition write (`RunDriver` `admit`).
 * Every resume of a run parked on a child does that. On PostgreSQL the edge's
 * own write names no partition, so it widened that transaction to the
 * schema's lock: a wait bounded by `lock_timeout` while any other partition's
 * writer shares the schema. With ten TODO runs resuming at once on smithers.sh
 * (2026-11-01) the widening timed out on every replay the writer allows, and
 * the parent died with `DatabaseError` `busy`.
 *
 * An edge already recorded is answered without a write, so the replay waits
 * for no other run's writer. The case holds another partition's write open
 * for its whole length, with a writer that replays a busy write once, so the
 * old widening fails in well under a second.
 */
import * as Pg from "@effect/sql-pg"
import { DurableWriter, PostgresDatabase } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/sql/SqlClient"
import { randomUUID } from "node:crypto"
import { connect } from "node:net"
import { describe, expect, it } from "vitest"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as Migrations from "../src/Migrations.ts"

/** The server the storage matrix provides, else the compose Postgres (`apps/mvp/docker-compose.yml`). */
const url = process.env.SMITHERS_TEST_PG_URL ?? process.env.SMITHERS_TEST_COMPOSE_PG_URL ??
  "postgresql://smithers:smithers@127.0.0.1:54321/smithers"

/** Only a refused connection means the server is absent; any other error fails the suite. */
const listening = (target: string): Promise<boolean> => {
  const { hostname, port } = new URL(target)
  return new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port: Number(port || 5432) })
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once(
      "error",
      (error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED" ? resolve(false) : reject(error)
    )
  })
}

const absent = (await listening(url))
  ? undefined
  : `nothing listens on ${new URL(url).host}; \`pnpm coverage\` provides a server`

/** A client of `schema` with its own pool, whose lock waits give up after 100 ms. */
const client = (schema: string) =>
  Effect.map(
    Layer.build(PostgresDatabase.layer({ url, driver: Pg, schema, writerLockTimeout: "100 millis" })),
    (context) => Context.get(context, SqlClient.SqlClient)
  )

describe("a parent edge recorded again", () => {
  if (absent !== undefined) {
    it.skip(`skipped: ${absent}`, () => {})
    return
  }

  it(
    "is answered inside the child's partition write while another run's writer shares the schema",
    () =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const schema = `parent_edge_${randomUUID().replaceAll("-", "")}`
        const engineSql = yield* client(schema)
        yield* Effect.addFinalizer(() => TestDatabase.dropSchema(engineSql, schema).pipe(Effect.orDie))
        // The engine's writer replays a busy write once, so a widening that waits out its lock fails fast.
        const writer = DurableWriter.make(engineSql, { maxAttempts: 2 })
        yield* Migrations.run.pipe(Effect.provideService(SqlClient.SqlClient, engineSql))
        const state = yield* DurableEngineState.make.pipe(
          Effect.provideService(DurableWriter.DurableWriter, writer),
          Effect.provideService(SqlClient.SqlClient, engineSql)
        )
        // The parent's first execution of its child recorded the edge.
        expect((yield* state.recordRunParent("child", "parent"))._tag).toBe("Recorded")

        // Another run's writer, on its own connection, holds its partition and so shares the schema's lock.
        const otherSql = yield* client(schema)
        const opened = yield* Deferred.make<void>()
        const released = yield* Deferred.make<void>()
        const other = yield* DurableWriter.make(otherSql).write(
          Effect.andThen(Deferred.succeed(opened, undefined), Deferred.await(released)),
          { partition: "another-run" }
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(opened)

        // The parent resumes and executes its child again: the edge is recorded inside the child's partition write.
        const replayed = yield* writer.write(state.recordRunParent("child", "parent"), { partition: "child" }).pipe(
          Effect.exit
        )
        yield* Deferred.succeed(released, undefined)
        yield* Fiber.join(other)

        expect(replayed).toMatchObject({ _tag: "Success", value: { _tag: "Existing" } })
        expect(yield* state.runParents("child")).toHaveLength(1)
      }))),
    30_000
  )
})
