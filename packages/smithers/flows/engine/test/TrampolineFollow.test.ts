/**
 * What one `execute` call hands its driver while it follows a lineage: each
 * round's position and follow flag, the ceilings a handoff adds, the poll
 * resume, the give-up, and how a waiting parent counts the lineage among its
 * actions. A scripted driver records every request, so each assertion reads
 * the contract a durable driver relies on.
 */
import { describe, expect, it } from "@effect/vitest"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import * as CapabilitySet from "@smthrs/capability/CapabilitySet"
import { Flow, FlowRuntime, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Deferred, Effect, Exit, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"
import { scriptedEngine } from "./ScriptedEngine.ts"

const Counter = Flow.make("trampoline-follow/counter", {
  payload: { n: Schema.Number },
  success: Schema.Number,
  body: () => Node.succeed(0)
})

const handoff = (n: number, capabilityCeilings?: ReadonlyArray<ReadonlyArray<CapabilityPattern>>) =>
  new Flow.Handoff({
    flow: Counter._tag,
    payload: { n },
    ...(capabilityCeilings === undefined ? {} : { capabilityCeilings: capabilityCeilings.map((group) => [...group]) })
  })

const complete = (value: number) => new Flow.Complete({ exit: Exit.succeed(value) })

interface Dispatch {
  readonly executionId: string
  readonly discard: boolean
  readonly round: unknown
  readonly follow: boolean | undefined
  readonly groups: CapabilitySet.CapabilitySet["groups"]
}

/**
 * A driver that answers each non-discarded dispatch with the next scripted
 * settlement, and records every dispatch and resume it receives.
 */
const recording = (next: (index: number) => Flow.Result<unknown, unknown>) => {
  const dispatches: Array<Dispatch> = []
  const resumes: Array<readonly [string, unknown]> = []
  let settled = 0
  const engine = scriptedEngine({
    execute: ((_flow: Flow.Any, options: {
      readonly executionId: string
      readonly discard: boolean
      readonly round: unknown
      readonly follow?: boolean
    }) =>
      Effect.map(CapabilitySet.current, (current) => {
        dispatches.push({
          executionId: options.executionId,
          discard: options.discard,
          round: options.round,
          follow: options.follow,
          groups: current.groups
        })
        return options.discard ? undefined : next(settled++)
      })) as never,
    resume: (_flow, executionId, request) => Effect.sync(() => void resumes.push([executionId, request]))
  })
  return { dispatches, engine, resumes }
}

const roundId = (rootExecutionId: string, ordinal: number) =>
  withCrypto(FlowEngine.Round.executionId({
    rootExecutionId: rootExecutionId as FlowEngine.Round.RootExecutionId,
    ordinal
  }))

/** Moves the test clock `step` at a time until `fiber` settles, at most `turns` times. */
const advanceUntilDone = Effect.fnUntraced(
  function*(fiber: Fiber.Fiber<unknown, unknown>, step: number, turns: number) {
    for (let turn = 0; turn < turns && fiber.pollUnsafe() === undefined; turn++) {
      yield* TestClock.adjust(step)
    }
  }
)

describe("a followed lineage's dispatches", () => {
  it.effect("does not revisit every earlier handoff's patterns when the ceiling repeats", () =>
    Effect.gen(function*() {
      let reads = 0
      const read = new CapabilityPattern({ action: "fs:read", resource: "src/**" })
      // Count real capability normalization work, independently of wall time.
      Object.defineProperty(read, "resource", {
        get: () => {
          reads++
          return "src/**"
        }
      })
      const perRound: Array<number> = []
      const { engine } = recording((index) => {
        perRound.push(reads)
        reads = 0
        return index === 39 ? complete(40) : handoff(index + 1, [[read]])
      })
      yield* engine.register(Counter, () => Effect.succeed(0))
      expect(
        yield* withCrypto(engine.execute(Counter, {
          executionId: "bounded-follower",
          payload: { n: 0 }
        }))
      ).toBe(40)
      expect(perRound).toHaveLength(40)
      expect(perRound[1]).toBeGreaterThan(0)
      expect(perRound[39]).toBe(perRound[1])
    }).pipe(Effect.scoped))

  it.effect("marks only the round after a handoff with its predecessor, and only followed rounds as follows", () =>
    Effect.gen(function*() {
      const script = [handoff(1), new Flow.Suspended({}), complete(7)]
      const { dispatches, engine, resumes } = recording((index) => script[index]!)
      yield* engine.register(Counter, () => Effect.succeed(0))
      const running = yield* Effect.forkChild(withCrypto(engine.execute(Counter, {
        executionId: "follow-run",
        payload: { n: 0 },
        suspendedRetryPolicy: RetryPolicy.make({ initialMs: 10, factor: 1, maxMs: 10 })
      })))
      yield* advanceUntilDone(running, 10, 10)

      expect(yield* Fiber.join(running)).toBe(7)
      const next = yield* roundId("follow-run", 1)
      expect(dispatches.map(({ groups: _, ...dispatch }) => dispatch)).toEqual([
        {
          executionId: "follow-run",
          discard: false,
          round: { rootExecutionId: "follow-run", ordinal: 0 },
          follow: undefined
        },
        {
          executionId: next,
          discard: false,
          round: { rootExecutionId: "follow-run", ordinal: 1, previousExecutionId: "follow-run" },
          follow: true
        },
        { executionId: next, discard: false, round: { rootExecutionId: "follow-run", ordinal: 1 }, follow: true }
      ])
      // The elapsed poll resumed the parked round as an automatic retry.
      expect(resumes).toEqual([[next, { poll: true }]])
    }).pipe(Effect.scoped))

  it.effect("follows a discarded execution's first round after admitting it", () =>
    Effect.gen(function*() {
      const { dispatches, engine } = recording(() => complete(3))
      yield* engine.register(Counter, () => Effect.succeed(0))
      const id = yield* withCrypto(engine.execute(Counter, {
        executionId: "follow-discard",
        payload: { n: 0 },
        discard: true
      }))
      for (let turn = 0; turn < 100 && dispatches.length < 2; turn++) yield* Effect.yieldNow

      expect(id).toBe("follow-discard")
      const round = { rootExecutionId: "follow-discard", ordinal: 0 }
      expect(dispatches.map(({ groups: _, ...dispatch }) => dispatch)).toEqual([
        { executionId: "follow-discard", discard: true, round, follow: undefined },
        { executionId: "follow-discard", discard: false, round, follow: true }
      ])
    }).pipe(Effect.scoped))

  it.effect("bounds each round by every ceiling the lineage's handoffs added, and a handoff naming none by nothing", () =>
    Effect.gen(function*() {
      const read = new CapabilityPattern({ action: "fs:read", resource: "src/**" })
      const script = [handoff(1, [[read]]), handoff(2), complete(9)]
      const { dispatches, engine } = recording((index) => script[index]!)
      yield* engine.register(Counter, () => Effect.succeed(0))
      const caller = (yield* CapabilitySet.current).groups

      expect(yield* withCrypto(engine.execute(Counter, { executionId: "follow-ceilings", payload: { n: 0 } }))).toBe(9)
      expect(dispatches.map((dispatch) => dispatch.groups)).toEqual([
        caller,
        CapabilitySet.fromPatterns([read]).groups,
        // An empty group admits no capability at all.
        [[]]
      ])
    }).pipe(Effect.scoped))
})

describe("a followed lineage's handoff refusal", () => {
  it.effect("names the round that handed off and the flow it named", () =>
    Effect.gen(function*() {
      const stranger = new Flow.Handoff({ flow: "trampoline-follow/stranger", payload: {} })
      const { dispatches, engine } = recording(() => stranger)
      yield* engine.register(Counter, () => Effect.succeed(0))
      const exit = yield* Effect.exit(
        withCrypto(engine.execute(Counter, { executionId: "follow-stranger", payload: { n: 0 } }))
      )

      const defect = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isDieReason)?.defect : undefined
      expect(defect).toBeInstanceOf(FlowEngine.FlowNotRegistered)
      expect(defect).toMatchObject({
        flowName: "trampoline-follow/stranger",
        message:
          `${Counter._tag} handed off to flow trampoline-follow/stranger, which is not registered with this engine`
      })
      expect(dispatches).toHaveLength(1)
    }).pipe(Effect.scoped))
})

describe("a followed lineage's give-up", () => {
  it.effect("names the caller's execution id and counts every elapsed poll, even after a handoff", () =>
    Effect.gen(function*() {
      const { engine, resumes } = recording((index) => index === 0 ? handoff(1) : new Flow.Suspended({}))
      yield* engine.register(Counter, () => Effect.succeed(0))
      const running = yield* Effect.forkChild(withCrypto(engine.execute(Counter, {
        executionId: "follow-give-up",
        payload: { n: 0 },
        suspendedRetryPolicy: RetryPolicy.make({ initialMs: 10, factor: 1, maxMs: 10, maxAttempts: 3 })
      })))
      yield* advanceUntilDone(running, 10, 20)

      expect(running.pollUnsafe()).toBeDefined()
      const exit = yield* Fiber.await(running)
      const defect = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isDieReason)?.defect : undefined
      expect(defect).toBeInstanceOf(FlowEngine.SuspendedResumeGaveUp)
      expect(defect).toMatchObject({
        flowName: Counter._tag,
        executionId: "follow-give-up",
        attempt: 3,
        reason: "exhausted",
        message: `${Counter._tag}.execute: suspendedRetryPolicy exhausted`
      })
      // Attempts 1 and 2 each slept out their delay and resumed the round.
      const next = yield* roundId("follow-give-up", 1)
      expect(resumes).toEqual([[next, { poll: true }], [next, { poll: true }]])
    }).pipe(Effect.scoped))

  // Issue #4677: a wall clock stepped back past the follow's start reads as a
  // negative elapsed time, which a policy without a bound must not give up on.
  it.effect("keeps polling under a policy that never gives up when the wall clock steps back", () =>
    Effect.gen(function*() {
      let dispatched = 0
      const engine = scriptedEngine({
        execute: (() =>
          Effect.gen(function*() {
            dispatched++
            if (dispatched > 1) return complete(7)
            yield* TestClock.setTime(0)
            return new Flow.Suspended({})
          })) as never
      })
      yield* engine.register(Counter, () => Effect.succeed(0))
      yield* TestClock.setTime(10_000)
      const running = yield* Effect.forkChild(withCrypto(engine.execute(Counter, {
        executionId: "follow-clock-steps-back",
        payload: { n: 0 },
        suspendedRetryPolicy: RetryPolicy.defaultRetryPolicy
      })))
      yield* advanceUntilDone(running, 200, 5)

      expect(yield* Fiber.join(running)).toBe(7)
      expect(dispatched).toBe(2)
    }).pipe(Effect.scoped))
})

describe("a lineage its parent awaits", () => {
  const child = (engine: FlowRuntime.FlowRuntime["Service"], instance: FlowRuntime.FlowInstance["Service"]) =>
    withCrypto(engine.execute(Counter, { executionId: `${instance.executionId}/child`, payload: { n: 0 } })).pipe(
      Effect.provideService(FlowRuntime.FlowInstance, instance)
    )

  it.effect("carries a suspended round's cause into the parent it parks", () =>
    Effect.gen(function*() {
      const parked = new Error("parked on a dependency")
      const { engine } = recording(() => new Flow.Suspended({ cause: Cause.die(parked) }))
      const instance = FlowEngine.makeInstance(Counter, "await-cause")
      const exit = yield* Fiber.await(yield* Effect.forkChild(child(engine, instance)))

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(instance.suspended).toBe(true)
      expect(instance.cause && Cause.squash(instance.cause)).toBe(parked)
    }).pipe(Effect.scoped))

  it.effect("parks the parent only once its sibling actions settle", () =>
    Effect.gen(function*() {
      const { engine } = recording(() => new Flow.Suspended({}))
      const instance = FlowEngine.makeInstance(Counter, "await-siblings")
      const siblingDone = yield* Deferred.make<void>()
      const sibling = yield* Effect.forkChild(
        Flow.wrapActionResult(Deferred.await(siblingDone), () => false).pipe(
          Effect.provideService(FlowRuntime.FlowInstance, instance)
        )
      )
      yield* Effect.yieldNow
      const parking = yield* Effect.forkChild(child(engine, instance))
      for (let turn = 0; turn < 100; turn++) yield* Effect.yieldNow
      expect(parking.pollUnsafe()).toBeUndefined()
      expect(instance.suspended).toBe(false)

      yield* Deferred.succeed(siblingDone, undefined)
      yield* Fiber.join(sibling)
      const exit = yield* Fiber.await(parking)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(instance.suspended).toBe(true)
    }).pipe(Effect.scoped))
})
