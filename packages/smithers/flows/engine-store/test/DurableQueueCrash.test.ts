import type * as SecureRandom from "effect/crypto/SecureRandom"
/**
 * `DurableQueue` workers on the durable engine: each item runs as a durable execution whose first step records the
 * handler's exit and whose second records it against the caller's deferred, retried by the engine without a limit.
 *
 * - A completion the store fails to record is retried on its own: the handler runs once and the caller gets its
 *   result (before, the next take ran the handler again, and after the queue's attempts the caller stayed parked).
 * - A worker that stops after the handler's exit was recorded leaves the next worker to replay that exit and record
 *   the completion: the handler is not run again.
 * - A worker that stops inside the handler leaves the next worker to run it again (at least once until recorded).
 *
 * Two workers stand for two processes: each runs over its own engine incarnation on one SQLite file, and the queue
 * is the SQL `PersistedQueue` store in that file. The completion store's failures are the engine runtime's own
 * `deferredDone`, wrapped. A worker stops in one of two ways. Released: its fiber is interrupted and its engine
 * closed, which releases its runs. Killed: its committed state is copied with `VACUUM INTO` while it is frozen, the
 * disk a SIGKILL leaves (the item's execution `running` under the dead owner, the queue row still locked by it), and
 * the next worker starts over the copy: it steals the execution and takes the item once the dead lock lapses.
 * Nothing is mocked.
 */
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Action, DurableQueue, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { Ownership } from "@smthrs/run-store"
import * as Context from "effect/Context"
import type * as EffectDigest from "effect/crypto/Digest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as PersistedQueue from "effect/persistence/PersistedQueue"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as SqlClient from "effect/sql/SqlClient"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as EngineStore from "../src/EngineStore.ts"
import * as OwnerIdentity from "../src/OwnerIdentity.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as PersistentDatabase from "./fixtures/PersistentDatabase.ts"
import { withCrypto } from "./Sha256.ts"

// No step here touches a workspace; Jj is only the host port the engine requires.
const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "queue" as never, changeId: "queue" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/** A single-instance host: an earlier incarnation on this host is gone, because the host runs one at a time. */
const singleInstance: Ownership.LivenessCheck = (owner, context) =>
  owner.hostId === context.claimant.hostId
    ? Effect.succeed(false)
    : Ownership.leaseLiveness()(owner, context)

const first: Ownership.OwnerId = { hostId: "worker-host", pid: 1, nonce: "first" }
const second: Ownership.OwnerId = { hostId: "worker-host", pid: 2, nonce: "second" }

let directory: string
let filename: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "durable-queue-crash-"))
  filename = PersistentDatabase.filename(join(directory, "engine.sqlite"))
})
afterEach(async () => {
  await PersistentDatabase.remove(filename)
  await rm(directory, { recursive: true, force: true })
})

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | (EffectDigest.Digest | SecureRandom.SecureRandom)>) =>
  Effect.runPromise(withCrypto(Effect.scoped(effect)))

const Queue = DurableQueue.make({
  name: "Crash",
  payload: { id: Schema.String, value: Schema.Number },
  success: Schema.Number,
  idempotencyKey: ({ id }) => id
})
const Offer = Action.make("DurableQueueCrash/offer", {
  payload: { id: Schema.String, value: Schema.Number },
  success: Schema.Number
})
const Caller = Flow.make("DurableQueueCrash/caller", {
  payload: { id: Schema.String, value: Schema.Number },
  success: Schema.Number,
  body: (payload) => Offer.call(payload)
})

/** What every incarnation did, shared across them as the database is. */
interface Observed {
  /** Each entry into the handler, by incarnation. */
  readonly handled: Array<string>
  /** Each attempt to record a completion, by incarnation and whether the store refused it. */
  readonly writes: Array<{ readonly by: string; readonly refused: boolean }>
}

/**
 * One incarnation's engine over `options.database` (the shared file by default), its queue store and the caller's
 * registration. Its runtime's `deferredDone` refuses the queue's first `refusals` completions; with `parkCompletion`
 * it never answers one.
 */
const incarnation = (
  owner: Ownership.OwnerId,
  observed: Observed,
  options: {
    readonly refusals?: number
    readonly parkCompletion?: Deferred.Deferred<void>
    readonly database?: string
  } = {}
) =>
  Effect.gen(function*() {
    const engine = EngineStore.layer({
      owner: { hostId: owner.hostId },
      journalSource: `${owner.nonce}-engine`,
      isAlive: singleInstance,
      sweep: "process"
    }).pipe(
      Layer.provide(OwnerIdentity.layerConstant(owner)),
      Layer.provideMerge(
        Layer.mergeAll(TestStores.layerAt(options.database ?? filename), StepBoundary.layerUnsupported, jj)
      )
    )
    let refused = 0
    const runtime = Layer.effect(FlowRuntime.FlowRuntime)(Effect.gen(function*() {
      const base = yield* FlowRuntime.FlowRuntime
      return FlowRuntime.FlowRuntime.of({
        ...base,
        deferredDone: (deferred, done) =>
          Effect.suspend(() => {
            if (!done.deferredName.startsWith(Queue.deferred.name)) return base.deferredDone(deferred, done)
            if (options.parkCompletion !== undefined) {
              observed.writes.push({ by: owner.nonce, refused: true })
              return Effect.andThen(Deferred.succeed(options.parkCompletion, undefined), Effect.never)
            }
            const refuse = refused < (options.refusals ?? 0)
            observed.writes.push({ by: owner.nonce, refused: refuse })
            if (refuse) {
              refused++
              return Effect.die("the completion store is unavailable")
            }
            return base.deferredDone(deferred, done)
          })
      })
    })).pipe(Layer.provideMerge(engine))
    return yield* Layer.build(
      Layer.mergeAll(
        Offer.toLayer((payload) => DurableQueue.process(Queue, payload)),
        Interpreter.layer(Caller)
      ).pipe(
        Layer.provideMerge(Action.layerImplementations),
        // A short lock lapse lets the next worker take an item a killed worker still holds; a live worker refreshes
        // its own lock well inside it.
        Layer.provideMerge(
          PersistedQueue.layer.pipe(
            Layer.provideMerge(
              PersistedQueue.layerStoreSql({ lockRefreshInterval: "100 millis", lockExpiration: "1 second" })
            )
          )
        ),
        Layer.provideMerge(runtime)
      )
    )
  })

/** Starts a worker in `context` whose handler counts its entries and runs `body`. */
const worker = (
  context: Context.Context<never>,
  owner: Ownership.OwnerId,
  observed: Observed,
  body: (value: number) => Effect.Effect<number> = (value) => Effect.succeed(value + 1)
) =>
  Effect.forkChild(
    Effect.provide(
      DurableQueue.makeWorker(Queue, ({ value }) =>
        Effect.suspend(() => {
          observed.handled.push(owner.nonce)
          return body(value)
        })),
      context as Context.Context<any>
    ),
    { startImmediately: true }
  )

type End = "released" | "killed"

/** A killed worker runs on SQLite, since `VACUUM INTO` is how its disk is copied. */
const dyingDatabase = (end: End) => end === "killed" ? join(directory, "engine.sqlite") : filename

/**
 * Stops the first worker. A killed one leaves the next incarnation only what its database had committed, copied
 * into a SQLite file nothing releases; a released one leaves the shared file after its engine closed.
 */
const stop = (end: End, dying: Context.Context<never>, dead: Fiber.Fiber<unknown>, dyingScope: Scope.Closeable) =>
  Effect.gen(function*() {
    const killed = join(directory, "killed.sqlite")
    if (end === "killed") {
      yield* Context.get(dying as Context.Context<SqlClient.SqlClient>, SqlClient.SqlClient)`VACUUM INTO ${killed}`
        .pipe(Effect.orDie)
      // What no scope close leaves: the dead owner still runs the item's execution and holds the queue row.
      const left = yield* Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        return {
          runs: yield* sql`SELECT status FROM flows_runs WHERE owner_nonce = ${first.nonce} AND status = 'running'`,
          locked: yield* sql`SELECT acquired_by FROM effect_queue WHERE acquired_by IS NOT NULL`
        }
      }).pipe(Effect.orDie, Effect.provide(NodeDatabase.layer({ filename: killed })))
      expect(left.runs.length).toBeGreaterThan(0)
      expect(left.locked).toHaveLength(1)
    }
    yield* Fiber.interrupt(dead)
    // The single-instance liveness check is valid only after the old engine has stopped.
    yield* Scope.close(dyingScope, Exit.void)
    return end === "killed" ? killed : filename
  })

/** Waits on the live clock: the SQL queue measures retry visibility with database time. */
const settled = (context: Context.Context<never>, executionId: string) =>
  Effect.gen(function*() {
    const runtime = Context.get(context as Context.Context<FlowRuntime.FlowRuntime>, FlowRuntime.FlowRuntime)
    let result = yield* runtime.poll(Caller, executionId)
    while (Option.isNone(result) || result.value._tag !== "Complete") {
      yield* Effect.sleep("10 millis")
      result = yield* runtime.poll(Caller, executionId)
    }
    return Option.flatMap(result, (value) => value._tag === "Complete" ? Option.some(value.exit) : Option.none())
  })

describe("DurableQueue on the durable engine", () => {
  it("retries a completion the store refuses on its own: the handler runs once and the caller gets its result", () =>
    run(Effect.gen(function*() {
      const observed: Observed = { handled: [], writes: [] }
      const context = yield* incarnation(first, observed, { refusals: 3 })
      const runtime = Context.get(context as Context.Context<FlowRuntime.FlowRuntime>, FlowRuntime.FlowRuntime)
      yield* worker(context, first, observed)
      yield* runtime.execute(Caller, { executionId: "refused", payload: { id: "refused", value: 41 }, discard: true })
      expect(yield* settled(context, "refused")).toEqual(Option.some(Exit.succeed(42)))
      expect(observed.handled).toEqual(["first"])
      expect(observed.writes).toEqual([
        { by: "first", refused: true },
        { by: "first", refused: true },
        { by: "first", refused: true },
        { by: "first", refused: false }
      ])
    })))

  it.each<End>(["released", "killed"])(
    "leaves the next worker to replay a recorded handler exit and record the completion (%s)",
    (end) =>
      run(Effect.gen(function*() {
        const observed: Observed = { handled: [], writes: [] }
        const parked = yield* Deferred.make<void>()
        const dyingScope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
        const dying = yield* incarnation(first, observed, { parkCompletion: parked, database: dyingDatabase(end) })
          .pipe(Effect.provideService(Scope.Scope, dyingScope))
        const runtime = Context.get(dying as Context.Context<FlowRuntime.FlowRuntime>, FlowRuntime.FlowRuntime)
        const dead = yield* worker(dying, first, observed)
        yield* runtime.execute(Caller, {
          executionId: "recorded",
          payload: { id: "recorded", value: 41 },
          discard: true
        })
        yield* Deferred.await(parked)
        // The first worker stops while recording the completion, after the handler's exit was recorded.
        const database = yield* stop(end, dying, dead, dyingScope)

        const next = yield* incarnation(second, observed, { database })
        yield* worker(next, second, observed)
        expect(yield* settled(next, "recorded")).toEqual(Option.some(Exit.succeed(42)))
        expect(observed.handled).toEqual(["first"])
        expect(observed.writes.at(-1)).toEqual({ by: "second", refused: false })
      }))
  )

  it.each<End>(["released", "killed"])(
    "leaves the next worker to run a handler again that stopped before its exit was recorded (%s)",
    (end) =>
      run(Effect.gen(function*() {
        const observed: Observed = { handled: [], writes: [] }
        const entered = yield* Deferred.make<void>()
        const dyingScope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
        const dying = yield* incarnation(first, observed, { database: dyingDatabase(end) }).pipe(
          Effect.provideService(Scope.Scope, dyingScope)
        )
        const runtime = Context.get(dying as Context.Context<FlowRuntime.FlowRuntime>, FlowRuntime.FlowRuntime)
        const dead = yield* worker(
          dying,
          first,
          observed,
          () => Effect.andThen(Deferred.succeed(entered, undefined), Effect.never)
        )
        yield* runtime.execute(Caller, { executionId: "died", payload: { id: "died", value: 41 }, discard: true })
        yield* Deferred.await(entered)
        const database = yield* stop(end, dying, dead, dyingScope)

        const next = yield* incarnation(second, observed, { database })
        yield* worker(next, second, observed)
        expect(yield* settled(next, "died")).toEqual(Option.some(Exit.succeed(42)))
        expect(observed.handled).toEqual(["first", "second"])
        expect(observed.writes).toEqual([{ by: "second", refused: false }])
      }))
  )
})
