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
 * for no other run's writer. The first case holds another partition's write
 * open for its whole length, with a writer that replays a busy write once, so
 * the old widening fails in well under a second.
 *
 * A new edge does take the schema's lock, and takes it where `admit` opens its
 * transaction. A parent records one for every round of a child's lineage the
 * first time it follows that round: a job that handed off three times gave its
 * parent three new edges in the resume after it settled, and that widening was
 * what still killed three of ten lanes after the first fix (2026-11-01). The
 * second case parks that follow behind another run's writer for longer than
 * the writer's replays last: the opening lock waits it out, as a widening
 * can't.
 */
import * as Pg from "@effect/sql-pg"
import { DurableWriter, PostgresDatabase } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { SqlJournal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as SqlClient from "effect/sql/SqlClient"
import { randomUUID } from "node:crypto"
import { connect } from "node:net"
import { describe, expect, it } from "vitest"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as Migrations from "../src/Migrations.ts"
import * as OwnerIdentity from "../src/OwnerIdentity.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import { withCrypto } from "./Sha256.ts"

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

const Opening = Action.make("parent-edge/Opening", { payload: {}, success: Schema.String })
const Closing = Action.make("parent-edge/Closing", { payload: {}, success: Schema.String })
/** A job's last round, as `ExternalJob`'s final `observe`. */
const LastRound = Flow.make("parent-edge/LastRound", {
  payload: {},
  success: Schema.String,
  body: Node.capture({}, () => Closing.call({}))
})
/** A job that hands off to its next round, as `ExternalJob`'s `launched` does. */
const Job = Flow.make("parent-edge/Job", {
  payload: {},
  success: Schema.String,
  body: Node.capture({}, () => Opening.call({}).pipe(Node.andThen(LastRound.to({}))))
})
/** A run that waits on the job, as a TODO's run does on `agent/Session`. */
const Parent = Flow.make("parent-edge/Parent", {
  payload: {},
  success: Schema.String,
  body: Node.capture({}, () => Job.child({}))
})

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "edge" as never, changeId: "edge" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/** The engine on `schema`, its lock waits 100 ms, its writer replaying a busy write once, and `opening` as the job's step. */
const engineOn = (schema: string, opening: Effect.Effect<string>) => {
  const stores = Layer.mergeAll(
    SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
    RunStore.layer,
    AttemptStore.layer,
    CacheStore.layer,
    DurableEngineState.layer
  ).pipe(Layer.provideMerge(Layer.provideMerge(Migrations.layer, DurableWriter.layer({ maxAttempts: 2 }))))
  const engine = EngineStore.layer({ owner: { hostId: "parent-edge" }, journalSource: "parent-edge" }).pipe(
    Layer.provide(OwnerIdentity.layer),
    Layer.provideMerge(Layer.mergeAll(stores, StepBoundary.layerUnsupported, jj))
  )
  const steps = Layer.mergeAll(
    Opening.toLayer(() => opening),
    Closing.toLayer(() => Effect.succeed("done"))
  )
  return Layer.mergeAll(
    Interpreter.layerWithImplementations(Parent, steps),
    Interpreter.layerWithImplementations(Job, steps),
    Interpreter.layerWithImplementations(LastRound, steps)
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(engine),
    Layer.provideMerge(PostgresDatabase.layer({ url, driver: Pg, schema, writerLockTimeout: "100 millis" }))
  )
}

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

  it("waits out another run's writer when a parent first follows a round of its child's lineage", () => {
    const schema = `parent_edge_${randomUUID().replaceAll("-", "")}`
    return Effect.runPromise(withCrypto(Effect.scoped(Effect.gen(function*() {
      const scope = yield* Effect.scope
      const dropper = yield* client(schema)
      yield* Effect.addFinalizer(() => TestDatabase.dropSchema(dropper, schema).pipe(Effect.orDie))
      // The job's step, its last before it hands off: from here another run's writer shares the schema, for far
      // longer than the engine's writer replays a busy write. The parent's follow of the next round lands inside it.
      const opening = Effect.gen(function*() {
        const otherSql = yield* client(schema).pipe(Effect.provideService(Scope.Scope, scope), Effect.orDie)
        const opened = yield* Deferred.make<void>()
        const writer = DurableWriter.make(otherSql).write(
          Effect.andThen(Deferred.succeed(opened, undefined), Effect.sleep("1 second")),
          { partition: "another-run" }
        )
        yield* Effect.forkIn(Effect.ignore(writer), scope)
        yield* Deferred.await(opened)
        return "opened"
      })
      const answer = yield* Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const engine = yield* FlowRuntime.FlowRuntime
        const done = yield* engine.execute(Parent, { executionId: "parent", payload: {} })
        const edges = yield* sql<{ readonly child_id: string }>`
          SELECT child_id FROM flows_run_parents WHERE parent_id = 'parent'`
        return { done, edges: edges.length }
      }).pipe(Effect.provide(engineOn(schema, opening)))
      // The job's first round and the round the parent followed it to.
      expect(answer).toEqual({ done: "done", edges: 2 })
    }))))
  }, 30_000)
})
