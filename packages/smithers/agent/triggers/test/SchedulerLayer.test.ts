import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import * as FlowRuntime from "@smthrs/flow/FlowRuntime"
import * as Cause from "effect/Cause"
import type * as EffectDigest from "effect/crypto/Digest"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as Scheduler from "../src/Scheduler.ts"
import * as TestTriggers from "../src/test/TestTriggers.ts"
import type { Trigger } from "../src/Trigger.ts"
import { TriggerError } from "../src/TriggerError.ts"
import * as TriggerStore from "../src/TriggerStore.ts"

const minute = 60_000
const hour = 60 * minute

const hourly = (overrides: Partial<Trigger> = {}): Trigger => ({
  id: "hourly",
  flowId: "flow",
  input: { source: "schedule" },
  cron: "0 * * * *",
  timezone: "UTC",
  overlap: "skip",
  catchUp: "none",
  maxCatchUp: 0,
  enabled: true,
  ...overrides
})

interface Runs {
  readonly service: Scheduler.RunnerService
  readonly starts: Array<Scheduler.StartInput>
  readonly active: Set<string>
}

/** A runtime that deduplicates by idempotency key, as a durable one must; `start` may hold a launch. */
const runs = (start: (key: string) => Effect.Effect<void, TriggerError> = () => Effect.void): Runs => {
  const starts: Array<Scheduler.StartInput> = []
  const active = new Set<string>()
  return {
    starts,
    active,
    service: Scheduler.makeRunner({
      start: (input) =>
        Effect.suspend(() => {
          starts.push(input)
          return start(input.idempotencyKey).pipe(
            Effect.map(() => {
              active.add(input.idempotencyKey)
              return input.idempotencyKey
            })
          )
        }),
      inspect: (runId) => Effect.sync(() => active.has(runId) ? "active" : "completed"),
      cancel: (runId) => Effect.sync(() => void active.delete(runId))
    })
  }
}

/** The engine the layer ticks on, in memory, with the crypto its keyed executions need. */
const engine = Layer.mergeAll(FlowEngine.layerMemory, NodeCrypto.layer)

/** Yields scheduler turns, without moving the clock, until `settled` holds; dies after `turns` turns. */
const until = (settled: () => boolean, turns = 2_000): Effect.Effect<void> =>
  Effect.gen(function*() {
    for (let turn = 0; turn < turns; turn++) {
      if (settled()) return
      yield* Effect.yieldNow
    }
    return yield* Effect.die(new Error("the engine never reached the expected state"))
  })

/** Runs a case on a fresh in-memory store, engine and test clock. */
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    TriggerStore.TriggerStore | FlowRuntime.FlowRuntime | EffectDigest.Digest | SecureRandom.SecureRandom
  >
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(TestTriggers.layer), Effect.provide(engine), Effect.provide(TestClock.layer()))
  )

/** A store that records which host each tick polled it as, through the heartbeat every tick records first. */
const beating = (store: TriggerStore.Service, beats: Array<string>): TriggerStore.Service =>
  TriggerStore.TriggerStore.of({
    ...store,
    heartbeat: (host) =>
      Effect.sync(() => {
        beats.push(host)
      }).pipe(Effect.andThen(store.heartbeat(host)))
  })

/** The scheduler layer over one store and one runner, on the case's engine. */
const scheduler = (options: Scheduler.Options, store: TriggerStore.Service, runner: Runs) =>
  Scheduler.layer(options).pipe(
    Layer.provide(Layer.succeed(TriggerStore.TriggerStore)(store)),
    Layer.provide(Layer.succeed(Scheduler.Runner)(runner.service))
  )

/** The first round of `host`'s lineage: its tag, and the payload it handed off with. */
const firstRound = (host: string) =>
  Effect.gen(function*() {
    const round = yield* Scheduler.Tick.poll(Scheduler.tickExecutionId(host))
    if (Option.isNone(round)) return { tag: "unsettled" as const }
    if (round.value._tag !== "Handoff") return { tag: round.value._tag }
    return {
      tag: round.value._tag,
      payload: yield* Schema.decodeUnknownEffect(Scheduler.Tick.payloadSchema)(round.value.payload)
    }
  })

/** Registers `hourly` with one completed occurrence at the epoch, so its first sight owes the current boundary. */
const seeded = (store: TriggerStore.Service) =>
  Effect.gen(function*() {
    const registered = yield* store.register(hourly())
    yield* store.claimFire({ triggerId: "hourly", occurrence: 0, expectedRevision: registered.revision })
    yield* store.recordResult({ triggerId: "hourly", occurrence: 0, outcome: "completed" })
  })

/** Collects the warnings a case logs. */
const warnings = () => {
  const messages: Array<string> = []
  const logger = Logger.make((record) => {
    if (record.logLevel === "Warn") messages.push(String(record.message))
  })
  return { messages, layer: Logger.layer([logger]) }
}

describe("Scheduler.layer", () => {
  // The poll loop lived in a forked fiber with the watermark in its memory. The
  // lineage keeps the watermark in the next round's payload and waits on the
  // engine's durable timer, so a host that dies between ticks loses nothing.
  it("ticks on the engine's durable timer: now, then once per poll interval, with the watermark in the next round's payload", async () => {
    const runner = runs()
    const beats: Array<string> = []
    const seen = await run(Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      yield* store.register(hourly())
      yield* TestClock.setTime(hour - 90_000)
      return yield* Effect.scoped(Effect.gen(function*() {
        yield* Layer.build(scheduler({ pollInterval: "1 minute", host: "edge" }, beating(store, beats), runner))
        yield* until(() => beats.length === 1)
        const parked = yield* firstRound("edge")
        yield* TestClock.adjust("1 minute")
        yield* until(() => beats.length === 2)
        const handed = yield* firstRound("edge")
        yield* TestClock.adjust("1 minute")
        yield* until(() => runner.starts.length === 1)
        return { parked, handed, heartbeat: yield* store.lastHeartbeat(), active: yield* store.activeRun("hourly") }
      }))
    }))
    expect(seen.parked).toEqual({ tag: "Suspended" })
    expect(seen.handed).toEqual({ tag: "Handoff", payload: { since: hour - 90_000 } })
    expect(beats).toEqual(["edge", "edge", "edge"])
    expect(runner.starts.map((start) => start.idempotencyKey)).toEqual(["hourly:1970-01-01T01:00:00.000Z"])
    expect(Option.map(seen.heartbeat, (beat) => beat.host)).toEqual(Option.some("edge"))
    expect(seen.active).toEqual(Option.some("hourly:1970-01-01T01:00:00.000Z"))
  })

  // A defect under a tick, which `Effect.catch` leaves alone, used to be the
  // supervisor's to survive. Here the step records it and the lineage goes on
  // with the watermark it had.
  it("logs a tick that dies and ticks again after the interval with the same watermark", async () => {
    const runner = runs()
    const logged = warnings()
    let listCalls = 0
    await run(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        yield* store.register(hourly())
        const failing = TriggerStore.TriggerStore.of({
          ...store,
          list: () => listCalls++ === 0 ? Effect.die(new Error("Unable to find cron date")) : store.list()
        })
        // A minute and a half before the hour: the tick after the failing one
        // establishes the watermark, and the tick after that crosses the boundary.
        yield* TestClock.setTime(hour - 90_000)
        yield* Effect.scoped(Effect.gen(function*() {
          yield* Layer.build(scheduler({ pollInterval: "1 minute" }, failing, runner))
          yield* until(() => listCalls === 1 && logged.messages.length === 1)
          yield* TestClock.adjust("1 minute")
          yield* until(() => listCalls === 2)
          const handed = yield* firstRound(Scheduler.defaultHost)
          yield* TestClock.adjust("1 minute")
          yield* until(() => runner.starts.length === 1)
          expect(handed).toEqual({ tag: "Handoff", payload: { since: null } })
        }))
      }).pipe(Effect.provide(logged.layer))
    )
    expect(logged.messages).toEqual(["A trigger scheduler tick failed"])
    expect(listCalls).toBe(3)
    expect(runner.starts.map((start) => start.idempotencyKey)).toEqual(["hourly:1970-01-01T01:00:00.000Z"])
  })

  // Closing the scope detaches from the lineage; the round parked on its timer
  // is the engine's. The next host under the same name joins it, so a restart
  // never opens a second lineage beside the first.
  it("joins the lineage an earlier host left parked and ticks it under the new registration", async () => {
    const first = runs()
    const second = runs()
    const beats: Array<string> = []
    const seen = await run(Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      yield* store.register(hourly())
      yield* TestClock.setTime(hour - 90_000)
      yield* Effect.scoped(Effect.gen(function*() {
        yield* Layer.build(scheduler({ pollInterval: "1 minute", host: "edge" }, beating(store, beats), first))
        yield* until(() => beats.length === 1)
      }))
      const left = yield* firstRound("edge")
      return yield* Effect.scoped(Effect.gen(function*() {
        yield* Layer.build(scheduler({ pollInterval: "1 minute", host: "edge" }, beating(store, beats), second))
        yield* TestClock.adjust("1 minute")
        yield* until(() => beats.length === 2)
        const handed = yield* firstRound("edge")
        yield* TestClock.adjust("1 minute")
        yield* until(() => second.starts.length === 1)
        return { left, handed }
      }))
    }))
    expect(seen.left).toEqual({ tag: "Suspended" })
    expect(seen.handed).toEqual({ tag: "Handoff", payload: { since: hour - 90_000 } })
    expect(beats).toEqual(["edge", "edge", "edge"])
    expect(first.starts).toHaveLength(0)
    expect(second.starts.map((start) => start.idempotencyKey)).toEqual(["hourly:1970-01-01T01:00:00.000Z"])
  })

  it("runs one tick now through runOnce, outside the lineage, from each trigger's last recorded fire", async () => {
    const runner = runs()
    const beats: Array<string> = []
    await run(Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      yield* seeded(store)
      yield* TestClock.setTime(hour + 1_000)
      yield* Effect.scoped(Effect.gen(function*() {
        const built = yield* Layer.build(scheduler({ pollInterval: "1 day" }, beating(store, beats), runner))
        yield* until(() => runner.starts.length === 1)
        runner.active.clear()
        yield* TestClock.setTime(2 * hour + 1_000)
        yield* Scheduler.Scheduler.use((service) => service.runOnce).pipe(Effect.provide(built))
      }))
    }))
    expect(runner.starts.map((start) => start.idempotencyKey)).toEqual([
      "hourly:1970-01-01T01:00:00.000Z",
      "hourly:1970-01-01T02:00:00.000Z"
    ])
    expect(beats).toEqual([Scheduler.defaultHost, Scheduler.defaultHost])
  })

  it("is interrupted, not failed, when its scope closes during a tick", async () => {
    const gate = Deferred.makeUnsafe<void>()
    const runner = runs(() => Deferred.await(gate))
    const logged = warnings()
    await run(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        yield* seeded(store)
        yield* TestClock.setTime(hour + 1_000)
        yield* Effect.scoped(Effect.gen(function*() {
          yield* Layer.build(scheduler({}, store, runner))
          yield* until(() => runner.starts.length === 1)
        }))
        yield* Deferred.succeed(gate, undefined)
      }).pipe(Effect.provide(logged.layer))
    )
    expect(runner.starts).toHaveLength(1)
    expect(logged.messages).toEqual([])
  })

  // Interruption is the scope closing, not a trigger failing, so a tick that
  // interrupts itself is not logged and retried like an ordinary failure.
  it("stops ticking when a tick interrupts itself, and logs no failure", async () => {
    const runner = runs()
    const logged = warnings()
    let listCalls = 0
    await run(
      Effect.gen(function*() {
        const store = TriggerStore.makeNoop({
          heartbeat: () => Effect.void,
          pruneFires: () => Effect.succeed(0),
          list: () =>
            Effect.suspend(() => {
              listCalls++
              return Effect.interrupt
            })
        })
        yield* Effect.scoped(Effect.gen(function*() {
          yield* Layer.build(scheduler({}, store, runner))
          yield* until(() => listCalls === 1)
          yield* TestClock.adjust("5 minutes")
          yield* until(() => true)
        }))
      }).pipe(Effect.provide(logged.layer))
    )
    expect(listCalls).toBe(1)
    expect(logged.messages).toEqual([])
  })

  it("reports an engine store that cannot record the lineage as a store failure", async () => {
    const runner = runs()
    const refused = await run(Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      const runtime = yield* FlowRuntime.FlowRuntime
      const failing = Layer.succeed(FlowRuntime.FlowRuntime, {
        ...runtime,
        execute: () =>
          Effect.fail(
            new FlowRuntime.StoreUnavailable({ executionId: Scheduler.tickExecutionId(Scheduler.defaultHost) })
          )
      })
      return yield* Effect.flip(Effect.scoped(Layer.build(scheduler({}, store, runner).pipe(Layer.provide(failing)))))
    }))
    expect(refused).toMatchObject({
      code: "store",
      message: "The flow engine could not start the trigger scheduler's tick lineage"
    })
    expect(refused.cause).toBeInstanceOf(FlowRuntime.StoreUnavailable)
  })

  // Every other refusal of the start is this composition's wiring, not a
  // state a host can retry out of, so it is a defect rather than a typed error.
  it("dies on an engine refusal that is not the store's", async () => {
    const runner = runs()
    const cycle = new FlowRuntime.FlowCycleDetected({ path: [Scheduler.tickTag, Scheduler.tickTag] })
    const exit = await run(Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      const runtime = yield* FlowRuntime.FlowRuntime
      const refusing = Layer.succeed(FlowRuntime.FlowRuntime, { ...runtime, execute: () => Effect.fail(cycle) })
      return yield* Effect.exit(Effect.scoped(Layer.build(scheduler({}, store, runner).pipe(Layer.provide(refusing)))))
    }))
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(cycle)
  })

  it("refuses options no tick could run under before it registers anything", async () => {
    const runner = runs()
    const refused = await run(Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      const build = (options: Scheduler.Options) =>
        Effect.flip(Effect.scoped(Layer.build(scheduler(options, store, runner))))
      return {
        pollInterval: yield* build({ pollInterval: 0 }),
        concurrency: yield* build({ concurrency: 0 }),
        lineage: yield* Scheduler.Tick.poll(Scheduler.tickExecutionId(Scheduler.defaultHost)).pipe(Effect.option)
      }
    }))
    expect(refused.pollInterval).toMatchObject({ code: "invalid_options", path: "pollInterval" })
    expect(refused.concurrency).toMatchObject({ code: "invalid_options", path: "concurrency" })
    expect(refused.lineage).toEqual(Option.none())
  })
})
