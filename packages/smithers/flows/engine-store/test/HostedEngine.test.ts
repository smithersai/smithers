import type * as SecureRandom from "effect/crypto/SecureRandom"
/**
 * An engine whose host wakes it from outside, `sweep: { host: executionId }`,
 * such as a Cloudflare Durable Object alarm that drives one execution per
 * invocation.
 *
 * Every case runs over a real store: SQLite, or PostgreSQL in the storage
 * matrix. Each hosted case has a `"process"` control beside it, so the
 * behavior it pins is the host mode's and not the fixture's.
 */
import * as SlowNetwork from "@smthrs/database/test/SlowNetwork"
import { Action, DurableClock, DurableDeferred, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { Ownership, RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import type * as EffectDigest from "effect/crypto/Digest"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import * as Tracer from "effect/Tracer"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as DeferredClockFold from "../src/DeferredClockFold.ts"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as OwnerIdentity from "../src/OwnerIdentity.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as WakeBus from "../src/WakeBus.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import * as PersistentDatabase from "./fixtures/PersistentDatabase.ts"
import { withCrypto } from "./Sha256.ts"

// No step here touches a workspace; Jj is only the host port the engine requires.
const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "hosted" as never, changeId: "hosted" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/**
 * The liveness a single-instance host gives: an earlier incarnation on this
 * host is gone, because the host runs one at a time; anything else keeps its
 * lease.
 */
const singleInstance: Ownership.LivenessCheck = (owner, context) =>
  owner.hostId === context.claimant.hostId
    ? Effect.succeed(false)
    : Ownership.leaseLiveness()(owner, context)

const engine = (filename: string, owner: Ownership.OwnerId, sweep: EngineStore.Sweep) =>
  EngineStore.layer({
    owner: { hostId: owner.hostId },
    journalSource: `${owner.hostId}-engine`,
    isAlive: singleInstance,
    sweep
  }).pipe(
    Layer.provide(OwnerIdentity.layerConstant(owner)),
    Layer.provideMerge(Layer.mergeAll(TestStores.layerAt(filename), StepBoundary.layerUnsupported, jj))
  )

const first: Ownership.OwnerId = { hostId: "durable-object", pid: 1, nonce: "first" }
const second: Ownership.OwnerId = { hostId: "durable-object", pid: 2, nonce: "second" }

const run = <A, E>(
  effect: Effect.Effect<A, E, Scope.Scope | TestClock.TestClock | (EffectDigest.Digest | SecureRandom.SecureRandom)>
) => Effect.runPromise(withCrypto(Effect.scoped(effect).pipe(Effect.provide(TestClock.layer()))))

let directory: string
let filename: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "hosted-engine-"))
  filename = PersistentDatabase.filename(join(directory, "engine.sqlite"))
})
afterEach(async () => {
  await PersistentDatabase.remove(filename)
  await rm(directory, { recursive: true, force: true })
})

const statusOf = (executionId: string) =>
  Effect.flatMap(RunStore.RunStore, (runs) => Effect.map(runs.get(executionId), (row) => row.status))

const Sleeper = Flow.make("HostedEngine/Sleeper", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

/** An engine with `Sleeper` registered: it naps on a ten-minute durable clock. */
const sleeper = (owner: Ownership.OwnerId, sweep: EngineStore.Sweep) =>
  Layer.effectDiscard(Effect.gen(function*() {
    const runtime = yield* FlowRuntime.FlowRuntime
    yield* runtime.register(Sleeper, () =>
      Effect.gen(function*() {
        yield* DurableClock.sleep({ name: "nap", duration: "10 minutes" })
        return "woke"
      }))
  })).pipe(
    Layer.provideMerge(engine(filename, owner, typeof sweep === "object" ? { ...sweep, flow: Sleeper._tag } : sweep))
  )

describe("registration under a hosted sweep", () => {
  it("re-arms only the hosted execution's clocks", () =>
    run(Effect.gen(function*() {
      // Two executions park on their ten-minute clocks under a process engine
      // that then goes away.
      yield* Effect.scoped(
        Effect.gen(function*() {
          const runtime = yield* FlowRuntime.FlowRuntime
          const runs = yield* RunStore.RunStore
          for (const executionId of ["mine", "theirs"]) {
            yield* runtime.execute(Sleeper, { executionId, payload: {}, discard: true })
            yield* runtime.resume(Sleeper, executionId, { poll: true })
            expect((yield* runs.get(executionId)).status).toBe("suspended")
          }
        }).pipe(Effect.provide(sleeper(first, "process")))
      )

      const hosted = yield* Effect.scoped(
        Effect.gen(function*() {
          yield* TestClock.adjust(Duration.minutes(10))
          // The hosted execution's own clock fired and its drive is done.
          yield* (yield* FlowRuntime.FlowRuntime).resume(Sleeper, "mine", { poll: true })
          return {
            mine: yield* statusOf("mine"),
            theirs: yield* statusOf("theirs"),
            theirsWake: yield* EngineStore.nextWake("theirs")
          }
        }).pipe(Effect.provide(sleeper(second, { host: "mine" })))
      )
      expect(hosted.mine).toBe("completed")
      // Nothing armed the other execution's clock, though it is due: its own
      // host drives it when `nextWake` says so.
      expect(hosted.theirs).toBe("suspended")
      expect(hosted.theirsWake).toEqual(Option.some(Duration.toMillis(Duration.minutes(10))))

      // The control: registering under a process sweep re-arms it.
      const theirs = yield* Effect.scoped(
        Effect.gen(function*() {
          yield* TestClock.adjust(Duration.minutes(10))
          yield* (yield* FlowRuntime.FlowRuntime).resume(Sleeper, "theirs", { poll: true })
          return yield* statusOf("theirs")
        }).pipe(Effect.provide(sleeper(second, "process")))
      )
      expect(theirs).toBe("completed")
    })))
})

describe("operator resume from an unregistered control runtime", () => {
  it.each([
    { duringPark: false, delegated: false },
    { duringPark: true, delegated: false },
    { duringPark: false, delegated: true },
    { duringPark: true, delegated: true }
  ])(
    "survives timer parking and is consumed once (duringPark=$duringPark, delegated=$delegated)",
    ({ duringPark, delegated }) =>
      run(Effect.gen(function*() {
        const executionId = "operator-wake"
        const flow = Flow.make("HostedEngine/OperatorWake", {
          payload: {},
          success: Schema.String,
          body: opaqueHandlerBody
        })
        const parking = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let starts = 0
        let finished = false
        const registered = (owner: Ownership.OwnerId) =>
          Layer.effectDiscard(Effect.flatMap(FlowRuntime.FlowRuntime, (runtime) =>
            runtime.register(flow, () =>
              Effect.gen(function*() {
                starts++
                if (finished) return "ended"
                yield* DurableClock.sleep({ name: "reading", duration: "10 minutes", inMemoryThreshold: 0 }).pipe(
                  Effect.ensuring(Effect.gen(function*() {
                    if (!duringPark || starts !== 1) return
                    yield* Deferred.succeed(parking, undefined)
                    yield* Deferred.await(release)
                  }))
                )
                return "read"
              })))).pipe(Layer.provideMerge(engine(filename, owner, { host: executionId, flow: flow._tag })))
        const control = Effect.scoped(
          Effect.gen(function*() {
            // This runtime has no handler and goes away before the next alarm.
            yield* (yield* FlowRuntime.FlowRuntime).resume(flow, executionId, { delegated })
          }).pipe(Effect.provide(engine(filename, second, { host: executionId, flow: flow._tag })))
        )
        const drive = (owner: Ownership.OwnerId) =>
          Effect.scoped(
            EngineStore.drive(flow, { executionId, payload: {} }).pipe(Effect.provide(registered(owner)))
          )
        if (duringPark) {
          const firstDrive = yield* Effect.forkChild(drive(first))
          yield* Deferred.await(parking)
          expect(yield* statusOf(executionId).pipe(Effect.provide(TestStores.layerAt(filename)))).toBe("running")
          yield* control
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(firstDrive)
        } else {
          expect(yield* drive(first)).toMatchObject({ _tag: "Parked", wakeAtMs: 600_000 })
          yield* control
        }
        if (!duringPark) {
          expect(yield* EngineStore.nextWake(executionId).pipe(Effect.provide(TestStores.layerAt(filename))))
            .toEqual(Option.some(0))
          expect(yield* drive(second)).toMatchObject({ _tag: "Parked", wakeAtMs: 600_000 })
        }
        // An active hosted drive takes up the boundary wake before returning; an idle one takes its next alarm.
        // Either way one wake buys one re-drive, not a spin until the timer is due.
        expect(starts).toBe(2)
        expect(yield* EngineStore.nextWake(executionId).pipe(Effect.provide(TestStores.layerAt(filename))))
          .toEqual(Option.some(600_000))
        // A later request at the SAME TestClock instant must still get a new wake.
        finished = true
        yield* control
        expect(yield* drive(second)).toEqual({ _tag: "Settled", status: "completed" })
        expect(starts).toBe(3)
        // Restore must preserve both wake admissions and their consumption, not resurrect a spent control request.
        yield* Effect.scoped(
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            const rows = sql`SELECT deferred_name, completed_at_ms, consumed_at_ms FROM flows_deferred_completions
          WHERE execution_id = ${executionId} ORDER BY deferred_name`
            const before = yield* rows
            expect(before).toHaveLength(2)
            expect(before.every((row) =>
              row.consumed_at_ms !== null
            )).toBe(true)
            yield* sql`UPDATE flows_deferred_completions SET consumed_at_ms = NULL WHERE execution_id = ${executionId}`
            yield* DeferredClockFold.rebuild()
            expect(yield* rows).toEqual(before)
          }).pipe(Effect.provide(TestStores.layerAt(filename)))
        )
      }))
  )
})

// Kept catalog-scaling benchmark: real store, 32 registrations, one hosted flow.
// Span counts are the deterministic gate; elapsed time is an observation only.
it.each([false, true])(
  "recovers only the hosted flow when registering a 32-flow catalog (hint=%s)",
  (hint) =>
    run(Effect.gen(function*() {
      const spans: Array<Tracer.NativeSpan> = []
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        }
      })
      const catalog = Array.from({ length: 32 }, (_, i) =>
        Flow.make(`catalog/${i}`, {
          payload: {},
          success: Schema.String,
          body: opaqueHandlerBody
        }))
      const postgres = /^postgres(?:ql)?:/.test(filename)
      const target = postgres ? yield* SlowNetwork.proxy(filename, { delayMs: 10 }) : filename
      const elapsedMs = yield* Effect.scoped(
        Effect.gen(function*() {
          const runtime = yield* FlowRuntime.FlowRuntime
          const started = performance.now()
          for (const flow of catalog) yield* runtime.register(flow, () => Effect.succeed("done"))
          return Math.round(performance.now() - started)
        }).pipe(
          Effect.provide(engine(target, first, { host: "catalog-run", ...(hint ? { flow: "catalog/17" } : {}) })),
          Effect.provideService(Tracer.Tracer, tracer)
        )
      )
      const recoveries = spans.filter((span) => span.name === "DeferredPersistence.sweepDue").length
      console.info(JSON.stringify({
        benchmark: "hosted-catalog-registration",
        flows: 32,
        hint,
        recoveries,
        elapsedMs,
        backend: postgres ? "postgres" : "sqlite",
        networkDelayEachWayMs: postgres ? 10 : 0
      }))
      expect(recoveries).toBe(hint ? 1 : 32)
    }))
)

describe("cancellation during hosted deferred recovery", () => {
  it.each([
    { hint: false, budgetMs: undefined },
    { hint: true, budgetMs: undefined },
    { hint: false, budgetMs: 0 },
    { hint: true, budgetMs: 0 },
    { hint: true, budgetMs: 600_000 }
  ])(
    "settles cancellation before another step (hint=$hint, budget=$budgetMs)",
    ({ hint, budgetMs }) =>
      run(Effect.gen(function*() {
        const executionId = "cancel-recovered"
        const event = DurableDeferred.make("merge", { success: Schema.String })
        const flow = Flow.make("HostedEngine/CancelRecovered", {
          payload: {},
          success: Schema.String,
          body: opaqueHandlerBody
        })
        let starts = 0
        const registration = (owner: Ownership.OwnerId) =>
          Layer.effectDiscard(Effect.flatMap(FlowRuntime.FlowRuntime, (runtime) =>
            runtime.register(flow, () =>
              Effect.gen(function*() {
                starts++
                return yield* DurableDeferred.await(event)
              })))).pipe(Layer.provideMerge(engine(filename, owner, {
                host: executionId,
                ...(hint ? { flow: flow._tag } : {})
              })))
        expect(
          yield* Effect.scoped(
            EngineStore.drive(flow, { executionId, payload: {} }).pipe(
              Effect.provide(registration(first))
            )
          )
        ).toEqual({ _tag: "Parked", wakeAtMs: undefined })
        const signal = Effect.flatMap(DurableEngineState.DurableEngineState, (state) =>
          state.completeDeferred({
            flowName: flow._tag,
            executionId,
            deferredName: event.name,
            exit: Exit.succeed("merged"),
            completedAtMs: 0
          })).pipe(Effect.provide(TestStores.layerAt(filename)))
        yield* signal
        yield* Effect.scoped(
          Effect.gen(function*() {
            const runtime = yield* FlowRuntime.FlowRuntime
            // Registration and another signal must not drive the parked body.
            yield* runtime.deferredDone(event, {
              flowName: flow._tag,
              executionId,
              deferredName: event.name,
              exit: Exit.succeed("merged")
            })
            expect(yield* statusOf(executionId)).toBe("suspended")
            expect(starts).toBe(1)
            yield* runtime.interrupt(flow, executionId)
            expect(yield* EngineStore.drive(flow, { executionId, payload: {}, budgetMs }))
              .toEqual({ _tag: "Settled", status: "cancelled" })
            expect(yield* statusOf(executionId)).toBe("cancelled")
          }).pipe(Effect.provide(registration(second)))
        )
        yield* signal
        expect(
          yield* Effect.scoped(
            EngineStore.drive(flow, { executionId, payload: {}, budgetMs }).pipe(
              Effect.provide(registration(second))
            )
          )
        ).toEqual({ _tag: "Settled", status: "cancelled" })
        expect(starts).toBe(1)
      }))
  )
})

const Blocker = Flow.make("HostedEngine/Blocker", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

describe("a hosted driver", () => {
  it.each([
    { sweep: { host: "blocked" } as RunDriver.Sweep, background: false },
    { sweep: "process" as RunDriver.Sweep, background: true }
  ])(
    "sweeps the store and renews a lease only under a process sweep ($sweep)",
    ({ background, sweep }) =>
      run(
        Effect.gen(function*() {
          const counted = { sweeps: 0, heartbeats: 0 }
          const runs = yield* RunStore.RunStore
          const engineState = yield* DurableEngineState.DurableEngineState
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const driver = yield* RunDriver.make({
            owner: first,
            journalSource: "hosted-driver",
            engine: Effect.succeed(fakeEngine),
            sweep
          }).pipe(
            // Every sweep tick starts with this read, and every lease renewal
            // with this write; both are counted where they are asked for.
            Effect.provideService(DurableEngineState.DurableEngineState, {
              ...engineState,
              waitingRuns: (filter) =>
                Effect.suspend(() => {
                  counted.sweeps++
                  return engineState.waitingRuns(filter)
                })
            }),
            Effect.provideService(RunStore.RunStore, {
              ...runs,
              heartbeat: (runId, owner, nowMs) =>
                Effect.suspend(() => {
                  counted.heartbeats++
                  return runs.heartbeat(runId, owner, nowMs)
                })
            })
          )
          yield* driver.register(
            Blocker,
            (): Effect.Effect<string> =>
              Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as("done"))
          )
          const execution = yield* Effect.forkChild(
            driver.execute(Blocker, { executionId: "blocked", payload: {}, discard: false })
          )
          yield* Deferred.await(started)
          for (let pulse = 0; pulse < 3; pulse++) {
            yield* TestClock.adjust(Ownership.heartbeatInterval)
            for (let turn = 0; turn < 10; turn++) yield* Effect.yieldNow
          }
          yield* Deferred.succeed(release, undefined)
          const settled = yield* Fiber.join(execution)
          expect(settled._tag).toBe("Complete")
          expect(counted.sweeps > 0).toBe(background)
          expect(counted.heartbeats > 0).toBe(background)
        }).pipe(Effect.provide(TestStores.layerAt(":memory:")))
      )
  )
})

const Speak = Action.make("HostedEngine/Speak", { payload: {}, success: Schema.Number })
const Answer = Flow.make("HostedEngine/Answer", {
  payload: {},
  success: Schema.Number,
  body: () => Speak.call({})
})

describe("an adopted attempt's fence", () => {
  it("refuses the earlier incarnation's write once a new incarnation takes the run", () =>
    run(Effect.gen(function*() {
      const firstStarted = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const writes: Array<{ readonly by: string; readonly attempt: number; readonly text: string; rows: number }> = []
      const redispatched: Array<{ readonly by: string; readonly redispatch: boolean }> = []
      // The step streams into an application table and fences every write.
      const speak = Speak.toLayer(() =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const fence = yield* Action.CurrentFence
          if (fence === undefined) return yield* Effect.die("the durable engine supplies a fence")
          redispatched.push({ by: fence.owner.nonce, redispatch: yield* Action.CurrentRedispatch })
          const write = (text: string) =>
            Effect.map(
              sql<{ readonly id: string }>`
                UPDATE hosted_answers SET text = ${text}
                WHERE id = 'answer' AND ${RunStore.owned(sql, fence)}
                RETURNING id
              `.pipe(Effect.orDie),
              (rows) => {
                writes.push({ by: fence.owner.nonce, attempt: fence.attempt, text, rows: rows.length })
                return rows.length
              }
            )
          if (fence.owner.nonce === first.nonce) {
            yield* write("first")
            yield* Deferred.succeed(firstStarted, undefined)
            yield* Deferred.await(releaseFirst)
            return yield* write("late")
          }
          return yield* write("second")
        })
      )
      const incarnation = (owner: Ownership.OwnerId) =>
        Layer.build(
          Interpreter.layer(Answer).pipe(
            Layer.provideMerge(speak),
            Layer.provideMerge(Action.layerImplementations),
            Layer.provideMerge(engine(filename, owner, { host: "answer" }))
          )
        )

      const firstContext = yield* incarnation(first)
      const firstRuntime = yield* Effect.provide(FlowRuntime.FlowRuntime, firstContext)
      yield* Effect.provide(
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* sql`CREATE TABLE hosted_answers (id TEXT PRIMARY KEY, text TEXT NOT NULL)`
          yield* sql`INSERT INTO hosted_answers (id, text) VALUES ('answer', '')`
        }),
        firstContext
      )
      yield* firstRuntime.execute(Answer, { executionId: "answer", payload: {}, discard: true })
      yield* Deferred.await(firstStarted)

      // The first incarnation stopped answering. A new one on the same host
      // takes the run at once, adopts the attempt still running, and finishes it.
      const secondContext = yield* incarnation(second)
      const secondRuntime = yield* Effect.provide(FlowRuntime.FlowRuntime, secondContext)
      const answer = { executionId: "answer", payload: {} }
      expect(yield* Effect.provide(EngineStore.drive(Answer, answer), secondContext))
        .toEqual({ _tag: "Settled", status: "completed" })
      const settled = yield* secondRuntime.poll(Answer, "answer")

      // The first incarnation wakes up and writes under the fence it captured.
      // Its drive then ends on the lost fence, and a drive joined to it
      // reports what the store holds: the run the second incarnation settled.
      yield* Deferred.succeed(releaseFirst, undefined)
      expect(yield* Effect.provide(EngineStore.drive(Answer, answer), firstContext))
        .toEqual({ _tag: "Settled", status: "completed" })

      const text = yield* Effect.provide(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql<{ readonly text: string }>`SELECT text FROM hosted_answers WHERE id = 'answer'`),
        secondContext
      )
      expect(writes).toEqual([
        { by: "first", attempt: 1, text: "first", rows: 1 },
        { by: "second", attempt: 1, text: "second", rows: 1 },
        { by: "first", attempt: 1, text: "late", rows: 0 }
      ])
      expect(text).toEqual([{ text: "second" }])
      // The second incarnation re-ran an attempt the first started and never
      // settled, and the body was told so.
      expect(redispatched).toEqual([{ by: "first", redispatch: false }, { by: "second", redispatch: true }])
      const succeeded = (result: Option.Option<{ readonly _tag: string; readonly exit?: Exit.Exit<number> }>) =>
        Option.map(result, (value) =>
          value._tag === "Complete" && value.exit !== undefined && Exit.isSuccess(value.exit))
      expect(succeeded(settled)).toEqual(Option.some(true))
      // The superseded drive changed nothing the new incarnation settled.
      expect(yield* secondRuntime.poll(Answer, "answer")).toEqual(settled)
    })))
})

describe("EngineStore.drive", () => {
  const Waiter = Flow.make("HostedEngine/Waiter", { payload: {}, success: Schema.String, body: opaqueHandlerBody })
  /** A hosted engine running `Sleeper` and `Waiter`, counting how often each body starts. */
  const hosted = (executionId: string, starts: { sleeper: number; waiter: number }) =>
    Layer.effectDiscard(Effect.gen(function*() {
      const runtime = yield* FlowRuntime.FlowRuntime
      yield* runtime.register(Sleeper, () =>
        Effect.gen(function*() {
          starts.sleeper++
          yield* DurableClock.sleep({ name: "nap", duration: "10 minutes" })
          return "woke"
        }))
      yield* runtime.register(Waiter, () =>
        Effect.gen(function*() {
          starts.waiter++
          return yield* DurableDeferred.await(DurableDeferred.make("answer", { success: Schema.String }))
        }))
    })).pipe(Layer.provideMerge(engine(filename, first, { host: executionId })))

  it("persists duplicate host admissions without starting a body until driven", () =>
    run(Effect.gen(function*() {
      const starts = { sleeper: 0, waiter: 0 }
      yield* Effect.gen(function*() {
        const driver = yield* EngineStore.Driver
        const input = { executionId: "admitted-nap", payload: {} }
        yield* driver.admit(Sleeper, input)
        yield* driver.admit(Sleeper, input)
        expect(yield* statusOf(input.executionId)).toBe("pending")
        expect(starts.sleeper).toBe(0)
        expect(yield* driver.drive(Sleeper, input)).toEqual({
          _tag: "Parked",
          wakeAtMs: Duration.toMillis(Duration.minutes(10))
        })
        expect(starts.sleeper).toBe(1)
        expect(yield* statusOf(input.executionId)).toBe("suspended")
      }).pipe(Effect.provide(hosted("admitted-nap", starts)))
    })))

  describe("a run that parks on a wake due soon", () => {
    const Blink = Flow.make("HostedEngine/Blink", { payload: {}, success: Schema.String, body: opaqueHandlerBody })
    /** A hosted engine whose `Blink` naps `seconds` on a durable clock, counting how often its body starts. */
    const blinking = (executionId: string, seconds: number, starts: { count: number }) =>
      Layer.effectDiscard(Effect.gen(function*() {
        yield* (yield* FlowRuntime.FlowRuntime).register(Blink, () =>
          Effect.gen(function*() {
            starts.count++
            // Durable however short, as `Sleep.action`'s, which a job's probe parks on.
            yield* DurableClock.sleep({ name: "blink", duration: Duration.seconds(seconds), inMemoryThreshold: 0 })
            return "awake"
          }))
      })).pipe(Layer.provideMerge(engine(filename, first, { host: executionId })))

    it("is driven again in the same drive once the wake comes due, as a probe's short sleep is", () =>
      run(Effect.gen(function*() {
        const starts = { count: 0 }
        const outcome = yield* Effect.gen(function*() {
          const driver = yield* EngineStore.Driver
          yield* driver.admit(Blink, { executionId: "blink", payload: {} })
          const drive = yield* Effect.forkChild(driver.drive(Blink, { executionId: "blink", payload: {} }))
          // The clock moves once the run has parked on its wake, however long the store took to get it there.
          for (let tries = 0; (yield* statusOf("blink")) !== "suspended"; tries++) {
            if (tries > 1_000) return yield* Effect.die("the run never parked")
            yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)))
          }
          yield* TestClock.adjust(Duration.seconds(1))
          return yield* Fiber.join(drive)
        }).pipe(Effect.provide(blinking("blink", 1, starts)))
        // Parked, then replayed and settled by the same drive: no second invocation of the host.
        expect(outcome).toEqual({ _tag: "Settled", status: "completed" })
        expect(starts.count).toBe(2)
      })))

    it("is handed back when the wake is past the hold, past the budget's end, or the hold is 0", () =>
      run(Effect.gen(function*() {
        const starts = { count: 0 }
        /** Admits `executionId`, then drives it once with `options`. */
        const admittedDrive = (
          executionId: string,
          options: { readonly budgetMs?: number; readonly holdMs?: number }
        ) =>
          Effect.gen(function*() {
            const driver = yield* EngineStore.Driver
            yield* driver.admit(Blink, { executionId, payload: {} })
            return yield* driver.drive(Blink, { executionId, payload: {}, ...options })
          })
        const later = yield* admittedDrive("nap-6", {}).pipe(Effect.provide(blinking("nap-6", 6, starts)))
        const short = yield* Effect.gen(function*() {
          const atBudget = yield* admittedDrive("nap-1", { budgetMs: 500 })
          const unheld = yield* admittedDrive("nap-1b", { holdMs: 0 })
          return { atBudget, unheld }
        }).pipe(Effect.provide(blinking("nap-1", 1, starts)))
        expect({ later, ...short }).toEqual({
          later: { _tag: "Parked", wakeAtMs: 6_000 },
          atBudget: { _tag: "Parked", wakeAtMs: 1_000 },
          unheld: { _tag: "Parked", wakeAtMs: 1_000 }
        })
        // Each parked once and was not driven again by the drive that parked it.
        expect(starts.count).toBe(3)
      })))
  })

  it("admits, parks until the clock is due, and settles once it is", () =>
    run(Effect.gen(function*() {
      const starts = { sleeper: 0, waiter: 0 }
      const nap = { executionId: "nap", payload: {} }
      const outcome = yield* Effect.gen(function*() {
        const admitted = yield* EngineStore.drive(Sleeper, nap)
        // Not yet due: the parked run is left alone, without a replay.
        yield* TestClock.adjust(Duration.minutes(5))
        const early = yield* EngineStore.drive(Sleeper, nap)
        const replaysBeforeDue = starts.sleeper
        yield* TestClock.adjust(Duration.minutes(5))
        const due = yield* EngineStore.drive(Sleeper, nap)
        return { admitted, early, replaysBeforeDue, due }
      }).pipe(Effect.provide(hosted("nap", starts)))
      const dueAtMs = Duration.toMillis(Duration.minutes(10))
      expect(outcome.admitted).toEqual({ _tag: "Parked", wakeAtMs: dueAtMs })
      expect(outcome.early).toEqual({ _tag: "Parked", wakeAtMs: dueAtMs })
      expect(outcome.replaysBeforeDue).toBe(1)
      expect(outcome.due).toEqual({ _tag: "Settled", status: "completed" })
    })))

  it("parks an execution waiting on an event with no wake of its own", () =>
    run(Effect.gen(function*() {
      const starts = { sleeper: 0, waiter: 0 }
      const outcome = yield* EngineStore.drive(Waiter, { executionId: "wait", payload: {} }).pipe(
        Effect.provide(hosted("wait", starts))
      )
      expect(outcome).toEqual({ _tag: "Parked", wakeAtMs: undefined })
      expect(starts.waiter).toBe(1)
    })))

  it("reports work it did not do, and fails for a flow it cannot run or an id it refuses", () =>
    run(Effect.gen(function*() {
      const starts = { sleeper: 0, waiter: 0 }
      const outcome = yield* Effect.gen(function*() {
        // Admitted by another writer for an engine routed elsewhere: still due.
        const runs = yield* RunStore.RunStore
        yield* runs.create(
          "elsewhere",
          JSON.stringify({ version: 1, flowName: Sleeper._tag, payload: {}, capabilityCeilings: [[]] })
        )
        const unfinished = yield* EngineStore.drive(Sleeper, { executionId: "elsewhere", payload: {} })
        const unregistered = yield* Effect.exit(EngineStore.drive(Blocker, { executionId: "nobody", payload: {} }))
        const refused = yield* Effect.flip(EngineStore.drive(Sleeper, { executionId: "", payload: {} }))
        return { unfinished, unregistered, refused }
      }).pipe(Effect.provide(
        EngineStore.layer({
          owner: { hostId: first.hostId },
          journalSource: "routed-elsewhere",
          isAlive: singleInstance,
          canExecute: () => Effect.succeed(false),
          sweep: { host: "elsewhere" }
        }).pipe(
          Layer.provide(OwnerIdentity.layerConstant(first)),
          Layer.provideMerge(Layer.mergeAll(TestStores.layerAt(filename), StepBoundary.layerUnsupported, jj)),
          Layer.tap((context) =>
            Effect.flatMap(
              Effect.succeed(Context.get(context, FlowRuntime.FlowRuntime)),
              (runtime) => runtime.register(Sleeper, () => Effect.succeed("never"))
            )
          )
        )
      ))
      expect(outcome.unfinished).toEqual({ _tag: "Unfinished" })
      expect(starts.sleeper).toBe(0)
      expect(Exit.isFailure(outcome.unregistered) && Cause.hasDies(outcome.unregistered.cause)).toBe(true)
      expect((outcome.refused as RunStore.RunStoreError).code).toBe("invalid_run")
    })))
})

describe("EngineStore.nextWake", () => {
  const owner: Ownership.OwnerId = { hostId: "next-wake", pid: 7, nonce: "owner" }
  const intruder: Ownership.OwnerId = { hostId: "other-host", pid: 8, nonce: "intruder" }
  const staleAfterMs = Duration.toMillis(Ownership.heartbeatStaleAfter)
  const state = JSON.stringify({ version: 1, flowName: Sleeper._tag, payload: {}, capabilityCeilings: [[]] })

  /** A run `owner` holds, parked as `waiting` unless that is `undefined`. */
  const owned = (runId: string, waiting?: DurableEngineState.Waiting) =>
    Effect.gen(function*() {
      const runs = yield* RunStore.RunStore
      const engineState = yield* DurableEngineState.DurableEngineState
      yield* runs.create(runId, state)
      const nowMs = yield* Clock.currentTimeMillis
      expect(yield* runs.claimAndOwn(runId, { status: "pending", owner: null, heartbeatAtMs: null }, owner, nowMs))
        .toEqual({ _tag: "Activated" })
      if (waiting === undefined) return
      expect((yield* engineState.park(runId, waiting, owner))._tag).toBe("Parked")
      expect(yield* runs.transitionOwned(runId, owner, "suspended")).toEqual({ _tag: "Transitioned" })
    })

  it("answers when each kind of run next needs its host", () =>
    run(
      Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        const engineState = yield* DurableEngineState.DurableEngineState
        yield* TestClock.adjust(Duration.seconds(100))
        const nowMs = 100_000

        expect(yield* EngineStore.nextWake("nothing")).toEqual(Option.none())

        yield* runs.create("pending", state)
        expect(yield* EngineStore.nextWake("pending")).toEqual(Option.some(nowMs))

        yield* runs.create("claimed", state)
        expect(
          (yield* runs.claim("claimed", { status: "pending", owner: null, heartbeatAtMs: null }, intruder, nowMs))
            ._tag
        ).toBe("Claimed")
        expect(yield* EngineStore.nextWake("claimed")).toEqual(Option.some(nowMs + staleAfterMs))

        yield* owned("running")
        expect(yield* EngineStore.nextWake("running")).toEqual(Option.some(nowMs + staleAfterMs))

        yield* owned("finished")
        expect(yield* runs.transitionOwned("finished", owner, "completed")).toEqual({ _tag: "Transitioned" })
        expect(yield* EngineStore.nextWake("finished")).toEqual(Option.none())

        yield* owned("waiting", { reason: "event" })
        expect(yield* EngineStore.nextWake("waiting")).toEqual(Option.none())

        yield* owned("cancelled", { reason: "event" })
        expect((yield* runs.requestCancel("cancelled", nowMs))._tag).toBe("CancelRequested")
        expect(yield* EngineStore.nextWake("cancelled")).toEqual(Option.some(nowMs))

        yield* owned("quarantined", { reason: "quarantine", token: "digest" })
        expect(yield* EngineStore.nextWake("quarantined")).toEqual(Option.none())

        yield* owned("released", { reason: "released" })
        expect(yield* EngineStore.nextWake("released")).toEqual(Option.some(nowMs))

        yield* owned("signalled", { reason: "event" })
        yield* engineState.completeDeferred({
          flowName: Sleeper._tag,
          executionId: "signalled",
          deferredName: "answer",
          exit: Exit.void,
          completedAtMs: nowMs
        })
        expect(yield* EngineStore.nextWake("signalled")).toEqual(Option.some(nowMs))

        yield* owned("sleeping")
        yield* engineState.scheduleClock({
          flowName: Sleeper._tag,
          executionId: "sleeping",
          clockName: "nap",
          deferredName: "nap",
          dueAtMs: nowMs + 60_000,
          completedAtMs: null
        }, owner)
        expect((yield* engineState.park("sleeping", { reason: "timer", wakeAt: nowMs + 60_000 }, owner))._tag)
          .toBe("Parked")
        expect(yield* runs.transitionOwned("sleeping", owner, "suspended")).toEqual({ _tag: "Transitioned" })
        expect(yield* EngineStore.nextWake("sleeping")).toEqual(Option.some(nowMs + 60_000))
        // A clock that came due is work now.
        yield* TestClock.adjust(Duration.minutes(2))
        expect(yield* EngineStore.nextWake("sleeping")).toEqual(Option.some(nowMs + 120_000))
      }).pipe(Effect.provide(TestStores.layerAt(filename)))
    ))

  it("fails with the store's error for an execution id the store refuses", () =>
    run(
      Effect.gen(function*() {
        const failure = yield* Effect.flip(EngineStore.nextWake(""))
        expect(failure.code).toBe("invalid_run")
      }).pipe(Effect.provide(TestStores.layerAt(filename)))
    ))
})

describe("an action's failure on the engine's spans", () => {
  const sentinel = "sentinel-5d2e-quoted-prompt"
  class Refused extends Schema.TaggedError<Refused>()("Refused", { code: Schema.String, message: Schema.String }) {}
  const Refuse = Action.make("HostedEngine/Refuse", { payload: {}, success: Schema.String, error: Refused })
  const Refusing = Flow.make("HostedEngine/Refusing", {
    payload: {},
    success: Schema.String,
    error: Refused,
    body: () => Refuse.call({})
  })

  it("exports only the failure's tag and code, while the flow fails with the original", () =>
    run(Effect.gen(function*() {
      const spans: Array<Tracer.NativeSpan> = []
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        }
      })
      const exit = yield* Effect.exit(Refusing.execute({}, { executionId: "refused" })).pipe(
        Effect.provide(
          Interpreter.layer(Refusing).pipe(
            Layer.provideMerge(
              Refuse.toLayer(() => Effect.fail(new Refused({ code: "rate_limited", message: sentinel })))
            ),
            Layer.provideMerge(Action.layerImplementations),
            Layer.provideMerge(engine(filename, first, { host: "refused" }))
          )
        ),
        Effect.provideService(Tracer.Tracer, tracer)
      )
      const failures = (name: string) =>
        spans.filter((span) => span.name === name).flatMap((span) =>
          span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
            ? Cause.prettyErrors(span.status.exit.cause).map((error) => `${error.name}: ${error.message}`)
            : []
        )
      expect(failures("Action.execute")).toEqual(["Refused: rate_limited"])
      expect(failures("ActionPersistence.execute")).toEqual(["Refused: rate_limited"])
      // No span the engine opened carries the failure's text.
      const exported = spans.flatMap((span) =>
        span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
          ? Cause.prettyErrors(span.status.exit.cause).map((error) => `${error.message}\n${error.stack}`)
          : []
      )
      expect(exported.join("\n")).not.toContain(sentinel)
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({ message: sentinel })
    })))
})

describe("a settled child's drive", () => {
  const LegTwo = Flow.make("HostedEngine/LegTwo", { payload: {}, success: Schema.Number, body: () => Speak.call({}) })
  const LegOne = Flow.make("HostedEngine/LegOne", { payload: {}, success: Schema.Number, body: () => LegTwo.to({}) })
  const Waits = Flow.make("HostedEngine/Waits", { payload: {}, success: Schema.Number, body: () => LegOne.child({}) })

  /**
   * The engine one execution's host builds: every flow registered, every
   * other execution routed away, and each wake the engine asks of a host
   * recorded in `resumes`.
   */
  const hosted = (executionId: string, resumes: Array<string>) =>
    Layer.mergeAll(Interpreter.layer(Waits), Interpreter.layer(LegOne), Interpreter.layer(LegTwo)).pipe(
      Layer.provideMerge(Speak.toLayer(() => Effect.succeed(7))),
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(
        EngineStore.layer({
          owner: { hostId: executionId },
          journalSource: `${executionId}-engine`,
          isAlive: singleInstance,
          canExecute: (row) => Effect.succeed(row.runId === executionId),
          requestResume: (parent, reason) => Effect.sync(() => resumes.push(`${parent}:${reason}`)),
          sweep: { host: executionId }
        }).pipe(
          Layer.provide(OwnerIdentity.layerConstant({ hostId: executionId, pid: 1, nonce: executionId })),
          Layer.provideMerge(Layer.mergeAll(TestStores.layerAt(filename), StepBoundary.layerUnsupported, jj))
        )
      )
    )

  it("announces the child it admits once the child's row has committed, and nothing else", () =>
    run(Effect.gen(function*() {
      const inStore = <A, E>(
        effect: Effect.Effect<A, E, RunStore.RunStore | DurableEngineState.DurableEngineState | SqlClient.SqlClient>
      ) => Effect.provide(effect, TestStores.layerAt(filename))
      // Each announcement with whether another connection already reads the child's row: it has committed.
      const announced: Array<WakeBus.Admission & { readonly committed: boolean }> = []
      const announce = (admission: WakeBus.Admission) =>
        inStore(Effect.flatMap(RunStore.RunStore, (runs) => runs.get(admission.executionId))).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
          Effect.map((committed) => {
            announced.push({ ...admission, committed })
          })
        )
      const drive = <F extends Flow.Any>(flow: F, executionId: string) =>
        EngineStore.drive(flow, { executionId, payload: {} }).pipe(
          Effect.provide(hosted(executionId, [])),
          Effect.provideService(WakeBus.Admitted, announce)
        )

      expect(yield* drive(Waits, "announces")).toEqual({ _tag: "Parked", wakeAtMs: undefined })
      const [edge] = yield* inStore(
        Effect.flatMap(DurableEngineState.DurableEngineState, (state) => state.runChildren("announces"))
      )
      // The parent's own admission is not a child's; the child's comes once, after its commit.
      expect(announced).toEqual([{ flow: LegOne._tag, executionId: edge!.childId, payload: {}, committed: true }])
      // The child hands off to its next round: no parent admitted that round, so nothing more is announced.
      expect(yield* drive(LegOne, edge!.childId)).toEqual({ _tag: "Settled", status: "completed" })
      expect(announced).toHaveLength(1)
    })))

  it("records its parent's wake again when the invocation that settled it died first, and only once", () =>
    run(Effect.gen(function*() {
      const resumes: Array<string> = []
      const drive = <F extends Flow.Any>(flow: F, executionId: string) =>
        EngineStore.drive(flow, { executionId, payload: {} }).pipe(Effect.provide(hosted(executionId, resumes)))
      const inStore = <A, E>(
        effect: Effect.Effect<A, E, RunStore.RunStore | DurableEngineState.DurableEngineState | SqlClient.SqlClient>
      ) => Effect.provide(effect, TestStores.layerAt(filename))
      const parentWake = inStore(EngineStore.nextWake("waits"))

      expect(yield* drive(Waits, "waits")).toEqual({ _tag: "Parked", wakeAtMs: undefined })
      const [edge] = yield* inStore(
        Effect.flatMap(DurableEngineState.DurableEngineState, (state) => state.runChildren("waits"))
      )
      const roundOne = edge!.childId

      // The child's first round hands off. It settled, but its lineage did
      // not: the parent is not woken.
      expect(yield* drive(LegOne, roundOne)).toEqual({ _tag: "Settled", status: "completed" })
      expect(resumes).toEqual([])
      expect(yield* parentWake).toEqual(Option.none())

      const rounds = yield* inStore(Effect.flatMap(RunStore.RunStore, (runs) => runs.lineage(roundOne)))
      const roundTwo = rounds[1]!.runId
      expect(yield* drive(LegTwo, roundTwo)).toEqual({ _tag: "Settled", status: "completed" })
      expect(resumes).toEqual(["waits:parent"])
      const nowMs = yield* Clock.currentTimeMillis
      expect(yield* parentWake).toEqual(Option.some(nowMs))

      // The invocation that settled the last round died before recording the
      // parent's wake: the store holds what that leaves behind.
      yield* inStore(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql`DELETE FROM flows_deferred_completions WHERE execution_id = 'waits'`
        )
      )
      expect(yield* parentWake).toEqual(Option.none())

      // The host drives the settled round again, and the wake is back.
      expect(yield* drive(LegTwo, roundTwo)).toEqual({ _tag: "Settled", status: "completed" })
      expect(resumes).toEqual(["waits:parent", "waits:parent"])
      expect(yield* parentWake).toEqual(Option.some(nowMs))
      // Another drive finds it recorded and schedules nothing more.
      expect(yield* drive(LegTwo, roundTwo)).toEqual({ _tag: "Settled", status: "completed" })
      expect(resumes).toEqual(["waits:parent", "waits:parent"])

      expect(yield* drive(Waits, "waits")).toEqual({ _tag: "Settled", status: "completed" })
      // The parent consumed the wake; driving the child again records none.
      const settledResumes = [...resumes]
      expect(yield* drive(LegTwo, roundTwo)).toEqual({ _tag: "Settled", status: "completed" })
      expect(resumes).toEqual(settledResumes)
      expect(yield* parentWake).toEqual(Option.none())
    })))
})
