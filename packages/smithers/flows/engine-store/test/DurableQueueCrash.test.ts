/**
 * `DurableQueue` workers on the durable engine: each item runs as a durable execution whose first step records the
 * handler's exit and whose second records it against the caller's deferred, retried by the engine without a limit.
 *
 * - A completion the store fails to record is retried on its own: the handler runs once and the caller gets its
 *   result (before, the next take ran the handler again, and after the queue's attempts the caller stayed parked).
 * - A worker that dies after the handler's exit was recorded leaves the next worker to replay that exit and record
 *   the completion: the handler is not run again.
 * - A worker that dies inside the handler leaves the next worker to run it again (at least once until recorded).
 *
 * Two workers stand for two processes: each runs over its own engine incarnation on one SQLite file, and the queue
 * is the SQL `PersistedQueue` store in that file. The completion store's failures are the engine runtime's own
 * `deferredDone`, wrapped; the first worker's death is the interruption of its fiber. Nothing is mocked.
 */
import { Action, DurableQueue, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { Ownership } from "@smthrs/run-store"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as PersistedQueue from "effect/persistence/PersistedQueue"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
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

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | Crypto.Crypto>) =>
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
 * One incarnation's engine over the shared file, its queue store and the caller's registration. Its runtime's
 * `deferredDone` refuses the queue's first `refusals` completions; with `parkCompletion` it never answers one.
 */
const incarnation = (
  owner: Ownership.OwnerId,
  observed: Observed,
  options: { readonly refusals?: number; readonly parkCompletion?: Deferred.Deferred<void> } = {}
) =>
  Effect.gen(function*() {
    const engine = EngineStore.layer({
      owner: { hostId: owner.hostId },
      journalSource: `${owner.nonce}-engine`,
      isAlive: singleInstance,
      sweep: "process"
    }).pipe(
      Layer.provide(OwnerIdentity.layerConstant(owner)),
      Layer.provideMerge(Layer.mergeAll(TestStores.layerAt(filename), StepBoundary.layerUnsupported, jj))
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
        Layer.provideMerge(PersistedQueue.layer.pipe(Layer.provideMerge(PersistedQueue.layerStoreSql()))),
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

  it("leaves the next worker to replay a recorded handler exit and record the completion", () =>
    run(Effect.gen(function*() {
      const observed: Observed = { handled: [], writes: [] }
      const parked = yield* Deferred.make<void>()
      const dying = yield* incarnation(first, observed, { parkCompletion: parked })
      const runtime = Context.get(dying as Context.Context<FlowRuntime.FlowRuntime>, FlowRuntime.FlowRuntime)
      const dead = yield* worker(dying, first, observed)
      yield* runtime.execute(Caller, { executionId: "recorded", payload: { id: "recorded", value: 41 }, discard: true })
      yield* Deferred.await(parked)
      // The first worker dies while recording the completion, after the handler's exit was recorded.
      yield* Fiber.interrupt(dead)

      const next = yield* incarnation(second, observed)
      yield* worker(next, second, observed)
      expect(yield* settled(next, "recorded")).toEqual(Option.some(Exit.succeed(42)))
      expect(observed.handled).toEqual(["first"])
      expect(observed.writes.at(-1)).toEqual({ by: "second", refused: false })
    })))

  it("leaves the next worker to run a handler again that died before its exit was recorded", () =>
    run(Effect.gen(function*() {
      const observed: Observed = { handled: [], writes: [] }
      const entered = yield* Deferred.make<void>()
      const dying = yield* incarnation(first, observed)
      const runtime = Context.get(dying as Context.Context<FlowRuntime.FlowRuntime>, FlowRuntime.FlowRuntime)
      const dead = yield* worker(
        dying,
        first,
        observed,
        () => Effect.andThen(Deferred.succeed(entered, undefined), Effect.never)
      )
      yield* runtime.execute(Caller, { executionId: "died", payload: { id: "died", value: 41 }, discard: true })
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(dead)

      const next = yield* incarnation(second, observed)
      yield* worker(next, second, observed)
      expect(yield* settled(next, "died")).toEqual(Option.some(Exit.succeed(42)))
      expect(observed.handled).toEqual(["first", "second"])
      expect(observed.writes).toEqual([{ by: "second", refused: false }])
    })))
})
