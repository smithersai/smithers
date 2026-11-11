import { TestSchemas } from "@smthrs/database"
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
 * A new edge whose child has no children can close no cycle, so it takes no
 * schema lock either. A parent records one for every round of a child's
 * lineage the first time it follows that round: a job that handed off three
 * times gave its parent three new edges in the resume after it settled, and
 * those widenings killed three of ten lanes after the first fix (2026-11-01).
 * The second case keeps another run's writer open until the parent has
 * finished, so nothing a run's own wait or admission writes may need the
 * schema's lock: a clock's schedule, a deferred's completion and consumption
 * took it on every wait, 2 s each at ten lanes. The rest prove what the lock gave:
 * edges that close a cycle still fail, written at once on separate connections.
 */
import * as Pg from "@effect/sql-pg"
import { DurableWriter, PostgresDatabase } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Action, Flow, FlowRuntime, Interpreter, Sleep } from "@smthrs/flow"
import { SqlJournal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/sql/SqlClient"
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
/** A job that parks on a clock, then hands off to its next round, as `ExternalJob`'s `observe` does. */
const Job = Flow.make("parent-edge/Job", {
  payload: {},
  success: Schema.String,
  error: Sleep.SleepRequestInvalid,
  body: Node.capture({}, () =>
    Opening.call({}).pipe(
      Node.andThen(Sleep.action.call({ millis: 10 })),
      Node.andThen(LastRound.to({}))
    ))
})
/** A run that waits on the job, as a TODO's run does on `agent/Session`. */
const Parent = Flow.make("parent-edge/Parent", {
  payload: {},
  success: Schema.String,
  error: Sleep.SleepRequestInvalid,
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

/** The engine on `schema`, its lock waits 100 ms, its writer replaying a busy write once. */
const engineOn = (schema: string) => {
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
    Opening.toLayer(() => Effect.succeed("opened")),
    Closing.toLayer(() => Effect.succeed("done")),
    Sleep.layer
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

describe.skipIf(absent !== undefined)("a parent edge recorded again", () => {
  it(
    "is answered inside the child's partition write while another run's writer shares the schema",
    () =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const schema = TestSchemas.schemaName("parent_edge")
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

  it("waits for no other run's writer when a job parks on a clock and its parent follows it to a new round", () => {
    const schema = TestSchemas.schemaName("parent_edge")
    return Effect.runPromise(withCrypto(Effect.scoped(Effect.gen(function*() {
      const dropper = yield* client(schema)
      yield* Effect.addFinalizer(() => TestDatabase.dropSchema(dropper, schema).pipe(Effect.orDie))
      const released = yield* Deferred.make<void>()
      const answer = yield* Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const engine = yield* FlowRuntime.FlowRuntime
        // Another run's writer shares the schema until the parent is done, so a schema lock anywhere in the parent's
        // admissions never comes: the first when it spawns the job, or the one when it follows the job's next round.
        const opened = yield* Deferred.make<void>()
        yield* DurableWriter.make(dropper).write(
          Effect.andThen(Deferred.succeed(opened, undefined), Deferred.await(released)),
          { partition: "another-run" }
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(opened)
        const done = yield* engine.execute(Parent, { executionId: "parent", payload: {} }).pipe(
          Effect.timeoutOption("10 seconds")
        )
        const edges = yield* sql<{ readonly child_id: string }>`
          SELECT child_id FROM flows_run_parents WHERE parent_id = 'parent'`
        return { done, edges: edges.length }
      }).pipe(Effect.provide(engineOn(schema)), Effect.ensuring(Deferred.succeed(released, undefined)))
      // The job's first round and the round the parent followed it to.
      expect(answer).toEqual({ done: Option.some("done"), edges: 2 })
    }))))
  }, 30_000)

  /** The engine state on `schema`, a connection of its own, writing with the default writer. */
  const stateOn = (schema: string) =>
    Effect.gen(function*() {
      const sql = yield* client(schema)
      const writer = DurableWriter.make(sql)
      return yield* DurableEngineState.make.pipe(
        Effect.provideService(DurableWriter.DurableWriter, writer),
        Effect.provideService(SqlClient.SqlClient, sql)
      )
    })

  it(
    "lets exactly one of edges that close a cycle commit, written at once",
    () =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const schema = TestSchemas.schemaName("parent_edge")
        const dropper = yield* client(schema)
        yield* Effect.addFinalizer(() => TestDatabase.dropSchema(dropper, schema).pipe(Effect.orDie))
        yield* Migrations.run.pipe(Effect.provideService(SqlClient.SqlClient, dropper))
        const [first, second, third] = [yield* stateOn(schema), yield* stateOn(schema), yield* stateOn(schema)]
        // Two runs each made the other's child, then three around a ring, every edge's child with no children.
        for (const ring of [["a", "b"], ["x", "y", "z"]] as const) {
          for (let round = 0; round < 10; round++) {
            const named = ring.map((id) => `${id}-${round}`)
            const exits = yield* Effect.all(
              named.map((child, index) =>
                Effect.exit([first, second, third][index]!.recordRunParent(child, named[(index + 1) % named.length]!))
              ),
              { concurrency: "unbounded" }
            )
            const at = `${ring.length} runs, round ${round}`
            const refused = exits.flatMap((exit, index) =>
              Exit.isFailure(exit) ? [{ child: named[index]!, error: Cause.squash(exit.cause) }] : []
            )
            // Only the typed refusal is admissible: a lock timeout or deadlock dies, and kills the admitting parent.
            expect(refused, at).toHaveLength(1)
            expect(refused[0]!.error, at).toBeInstanceOf(DurableEngineState.RunParentCycleError)
            for (const [index, child] of named.entries()) {
              const parents = (yield* first.runParents(child)).map((edge) => edge.parentId)
              expect(parents, `${at}, ${child}`).toEqual(
                child === refused[0]!.child ? [] : [named[(index + 1) % named.length]]
              )
            }
          }
        }
      }))),
    60_000
  )

  it(
    "still refuses an edge from a run with children to one of its descendants, and an edge to itself",
    () =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const schema = TestSchemas.schemaName("parent_edge")
        const dropper = yield* client(schema)
        yield* Effect.addFinalizer(() => TestDatabase.dropSchema(dropper, schema).pipe(Effect.orDie))
        yield* Migrations.run.pipe(Effect.provideService(SqlClient.SqlClient, dropper))
        const state = yield* stateOn(schema)
        expect((yield* state.recordRunParent("leaf", "middle"))._tag).toBe("Recorded")
        expect((yield* state.recordRunParent("middle", "root"))._tag).toBe("Recorded")
        expect((yield* Effect.flip(state.recordRunParent("root", "leaf"))).path).toEqual(["root", "middle", "leaf"])
        expect(yield* state.runParents("root")).toEqual([])
        expect((yield* Effect.flip(state.recordRunParent("loop", "loop")))._tag).toBe(
          "@smthrs/engine-store/RunParentCycleError"
        )
      }))),
    30_000
  )
})
