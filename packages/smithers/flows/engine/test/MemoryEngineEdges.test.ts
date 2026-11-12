import * as Hex from "effect/encoding/Hex"
/**
 * Edges of the in-memory engine the broader suites only pass through: a
 * cancellation landing between two rounds, a deferred completed twice, a
 * parent that fails without expiring, a follower's wake and its polls of a
 * run its own timer will wake, and payloads that only the conservative shape
 * comparison can tell apart.
 */
import { describe, expect } from "@effect/vitest"
import { syncCrypto } from "@smthrs/crypto"
import { DurableClock, DurableDeferred, Flow, FlowRuntime, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Deferred, Effect, Exit, Fiber, Option, Schema } from "effect"
import * as EffectDigest from "effect/crypto/Digest"
import { TestClock } from "effect/testing"
import { FlowEngine } from "../src/index.ts"
import { effect, pollUntil } from "./Harness.ts"

const settledComplete = <A, E>(result: Flow.Result<A, E>) => result._tag === "Complete"

/** Reads "not admitted yet" as "not settled yet". */
const pollOf = <A, R>(poll: Effect.Effect<Option.Option<A>, FlowRuntime.FlowExecutionNotFound, R>) =>
  poll.pipe(Effect.catchTag("@smthrs/flow/FlowExecutionNotFound", () => Effect.succeedNone))

const completedExit = (result: Option.Option<Flow.Result<unknown, unknown>>) =>
  Option.isSome(result) && result.value._tag === "Complete" ? result.value.exit : undefined

describe("a lineage cancelled between rounds", () => {
  const Round = Flow.make("memory-edges/round", {
    payload: { ordinal: Schema.Number },
    success: Schema.String,
    body: () => Node.succeed("inert")
  })

  /** SHA-256 that announces each digest on `reached` and computes it once `open` completes. */
  const gatedCrypto = (reached: Deferred.Deferred<void>, open: Deferred.Deferred<void>) =>
    EffectDigest.Digest.of({
      digest: (algorithm, input) =>
        Deferred.succeed(reached, undefined).pipe(
          Effect.andThen(Deferred.await(open)),
          Effect.andThen(syncCrypto.digest(algorithm, input))
        ),
      digestHex(algorithm, data) {
        return Effect.map(this.digest(algorithm, data), Hex.encode)
      }
    })

  effect(
    "refuses the next round when the cancellation lands before that round is admitted",
    () =>
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        let nextCalls = 0
        yield* engine.register(Round, ({ ordinal }) =>
          ordinal === 0
            ? Effect.gen(function*() {
              const instance = yield* FlowRuntime.FlowInstance
              instance.handoff = new Flow.Handoff({ flow: Round._tag, payload: { ordinal: 1 } })
              return "ignored"
            })
            : Effect.sync(() => {
              nextCalls++
              return "forbidden"
            }))
        // The follower derives round 1's id through Crypto, so holding that
        // digest holds it between round 0's handoff and round 1's admission.
        const reached = yield* Deferred.make<void>()
        const open = yield* Deferred.make<void>()
        yield* engine.execute(Round, { executionId: "gap", payload: { ordinal: 0 }, discard: true }).pipe(
          Effect.provideService(EffectDigest.Digest, gatedCrypto(reached, open))
        )
        yield* Deferred.await(reached)
        yield* engine.interrupt(Round, "gap")
        yield* Deferred.succeed(open, undefined)

        const next = yield* FlowEngine.Round.executionId({
          rootExecutionId: "gap" as FlowEngine.Round.RootExecutionId,
          ordinal: 1
        })
        const exit = completedExit(yield* pollUntil(pollOf(Round.poll(next)), settledComplete, { turns: 200 }))
        expect(exit !== undefined && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(nextCalls).toBe(0)
      }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory))
  )
})

describe("a deferred completed twice", () => {
  effect("keeps the first completion", () =>
    Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const Gate = DurableDeferred.make("memory-edges/first-wins", { success: Schema.String })
      const Waits = Flow.make("memory-edges/first-wins", {
        payload: {},
        success: Schema.String,
        body: () => Node.succeed("inert")
      })
      yield* engine.register(Waits, () => DurableDeferred.await(Gate))
      const token = DurableDeferred.tokenFromExecutionId(Gate, { flow: Waits, executionId: "first-wins" })
      // Both completions land before the run first reads the deferred.
      yield* DurableDeferred.succeed(Gate, { token, value: "first" })
      yield* DurableDeferred.succeed(Gate, { token, value: "second" })

      expect(yield* Waits.execute({}, { executionId: "first-wins" })).toBe("first")
    }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory)))
})

describe("a parent that fails", () => {
  effect("leaves its linked children running when the failure is not its deadline", () =>
    Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const Parent = Flow.make("memory-edges/failing-parent", {
        payload: {},
        success: Schema.String,
        error: Schema.String,
        body: () => Node.succeed("inert")
      })
      const Child = Flow.make("memory-edges/linked-child", {
        payload: {},
        success: Schema.String,
        body: () => Node.succeed("inert")
      })
      let parent: FlowRuntime.FlowInstance["Service"] | undefined
      const entered = yield* Deferred.make<void>()
      const fail = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* engine.register(Parent, () =>
        Effect.gen(function*() {
          parent = yield* FlowRuntime.FlowInstance
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(fail)
          return yield* Effect.fail("parent failed")
        }))
      yield* engine.register(Child, () => Effect.as(Deferred.await(release), "child done"))
      yield* engine.execute(Parent, { executionId: "failing-parent", payload: {}, discard: true })
      yield* Deferred.await(entered)
      yield* engine.execute(Child, { executionId: "linked-child", payload: {}, discard: true }).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, parent!)
      )
      yield* Deferred.succeed(fail, undefined)

      const failed = completedExit(
        yield* pollUntil(pollOf(Parent.poll("failing-parent")), settledComplete, { turns: 200 })
      )
      expect(failed !== undefined && Exit.isFailure(failed) && Cause.squash(failed.cause)).toBe("parent failed")
      expect(yield* pollOf(Child.poll("linked-child"))).toEqual(Option.none())
      yield* Deferred.succeed(release, undefined)
      const child = completedExit(yield* pollUntil(pollOf(Child.poll("linked-child")), settledComplete, { turns: 200 }))
      expect(child).toEqual(Exit.succeed("child done"))
    }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory)))
})

describe("a follower's wake", () => {
  for (const completesOnResume of [false, true]) {
    effect(
      completesOnResume
        ? "settles the follower on resume without waiting for its backoff"
        : "wakes the follower once, then holds it to its backoff until an elapsed poll resumes the run",
      () =>
        Effect.gen(function*() {
          const engine = yield* FlowRuntime.FlowRuntime
          const Parks = Flow.make("memory-edges/parks", {
            payload: {},
            success: Schema.String,
            body: () => Node.succeed("inert")
          })
          let ready = false
          let drives = 0
          yield* engine.register(Parks, () =>
            Effect.gen(function*() {
              drives++
              if (ready) return "ready"
              return yield* Flow.suspend(yield* FlowRuntime.FlowInstance)
            }))
          const following = yield* Effect.forkChild(engine.execute(Parks, {
            executionId: "parks",
            payload: {},
            suspendedRetryPolicy: RetryPolicy.make({ initialMs: 1000, factor: 1, maxMs: 1000 })
          }))
          const parked = (result: Flow.Result<unknown, unknown>) => result._tag === "Suspended"
          yield* pollUntil(pollOf(Parks.poll("parks")), parked, { turns: 200 })
          for (let turn = 0; turn < 50; turn++) yield* Effect.yieldNow
          expect(following.pollUnsafe()).toBeUndefined()
          // A resume must wake the waiting follower even if its backoff never elapses.
          ready = completesOnResume
          yield* engine.resume(Parks, "parks")
          for (let turn = 0; turn < 50; turn++) yield* Effect.yieldNow
          expect(drives).toBe(2)

          if (!completesOnResume) {
            ready = true
            yield* TestClock.adjust(1000)
          }
          for (let turn = 0; turn < 200 && following.pollUnsafe() === undefined; turn++) yield* Effect.yieldNow
          expect(following.pollUnsafe()).toBeDefined()
          expect(yield* Fiber.join(following)).toBe("ready")
          expect(drives).toBe(completesOnResume ? 2 : 3)
        }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory))
    )
  }
})

describe("a follower's poll of a run parked on its own timer", () => {
  effect(
    "leaves the run to its timer: no elapsed poll re-drives it before the timer fires",
    () =>
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        const Cools = Flow.make("memory-edges/cools", {
          payload: {},
          success: Schema.String,
          body: () => Node.succeed("inert")
        })
        let drives = 0
        yield* engine.register(Cools, () =>
          Effect.gen(function*() {
            drives++
            yield* DurableClock.sleep({ name: "cooldown", duration: "5 seconds", inMemoryThreshold: 1 })
            return "cooled"
          }))
        // The default policy's polls (200 ms growing by 1.5x) elapse six times
        // inside the timer's five seconds. The durable engine re-drives a
        // parked run on a poll only for a due wake; this engine's timer is that
        // wake, and it re-drives the run itself when it fires.
        const following = yield* Effect.forkChild(engine.execute(Cools, {
          executionId: "cools",
          payload: {},
          suspendedRetryPolicy: RetryPolicy.defaultRetryPolicy
        }))
        const parked = (result: Flow.Result<unknown, unknown>) => result._tag === "Suspended"
        yield* pollUntil(pollOf(Cools.poll("cools")), parked, { turns: 200 })
        expect(drives).toBe(1)

        yield* TestClock.adjust(5000)
        for (let turn = 0; turn < 200 && following.pollUnsafe() === undefined; turn++) yield* Effect.yieldNow
        expect(yield* Fiber.join(following)).toBe("cooled")
        expect(drives).toBe(2)
      }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory))
  )

  effect(
    "re-drives the run on the next poll when a resume found its round still running",
    () =>
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        const Cools = Flow.make("memory-edges/cools-after-a-live-resume", {
          payload: {},
          success: Schema.String,
          body: () => Node.succeed("inert")
        })
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let drives = 0
        yield* engine.register(Cools, () =>
          Effect.gen(function*() {
            drives++
            if (drives === 1) {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
            }
            yield* DurableClock.sleep({ name: "cooldown", duration: "5 seconds", inMemoryThreshold: 1 })
            return "cooled"
          }))
        const following = yield* Effect.forkChild(engine.execute(Cools, {
          executionId: "cools-after-a-live-resume",
          payload: {},
          suspendedRetryPolicy: RetryPolicy.defaultRetryPolicy
        }))
        // A resume while the round runs cannot re-drive it, and a completion
        // recorded then may be one the round parks without reading.
        yield* Deferred.await(entered)
        yield* engine.resume(Cools, "cools-after-a-live-resume")
        yield* Deferred.succeed(release, undefined)
        const parked = (result: Flow.Result<unknown, unknown>) => result._tag === "Suspended"
        yield* pollUntil(pollOf(Cools.poll("cools-after-a-live-resume")), parked, { turns: 200 })
        expect(drives).toBe(1)

        // So the first elapsed poll re-drives it, and the timer still wakes it.
        yield* TestClock.adjust(200)
        for (let turn = 0; turn < 50; turn++) yield* Effect.yieldNow
        expect(drives).toBe(2)
        yield* TestClock.adjust(5000)
        for (let turn = 0; turn < 200 && following.pollUnsafe() === undefined; turn++) yield* Effect.yieldNow
        expect(yield* Fiber.join(following)).toBe("cooled")
        expect(drives).toBe(3)
      }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory))
  )
})

describe("an opaque payload join", () => {
  const Opaque = Flow.make("memory-edges/opaque", {
    payload: { value: Schema.declare<object>((_value): _value is object => true) },
    success: Schema.Void,
    body: () => Node.succeed(undefined)
  })

  const joinExit = (executionId: string, first: object, second: object) =>
    Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      yield* engine.execute(Opaque, { executionId, payload: { value: first }, discard: true })
      return yield* engine.execute(Opaque, { executionId, payload: { value: second }, discard: true }).pipe(Effect.exit)
    })

  const payloadConflict = (exit: Exit.Exit<unknown, unknown>) => {
    const defect = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isDieReason)?.defect : undefined
    return defect instanceof FlowEngine.ExecutionIdentityConflict && defect.field === "payload"
  }

  effect("refuses another key even when both keys hold undefined", () =>
    Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      yield* engine.register(Opaque, () => Effect.void)
      expect(payloadConflict(yield* joinExit("opaque-keys", { left: undefined }, { right: undefined }))).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory)))

  effect(
    "refuses an array of another length even when its holes hide the difference from its keys",
    () =>
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        yield* engine.register(Opaque, () => Effect.void)
        const holed = Object.assign(new Array<string>(2), { 0: "x" })
        expect(payloadConflict(yield* joinExit("opaque-holes", holed, ["x"]))).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory))
  )
})

describe("collection payloads (VIP-44)", () => {
  const Tagged = Flow.make("memory-edges/tagged", {
    payload: { tags: Schema.ReadonlySet(Schema.String), owners: Schema.ReadonlyMap(Schema.String, Schema.Number) },
    success: Schema.Array(Schema.String),
    body: () => Node.succeed([])
  })

  effect("hands the body the sorted order its identity hashes", () =>
    Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      yield* engine.register(
        Tagged,
        (payload) => Effect.succeed([...payload.tags, ...[...payload.owners.keys()].map((key) => `owner:${key}`)])
      )
      const seen = yield* engine.execute(Tagged, {
        executionId: "tagged-order",
        payload: { tags: new Set(["c", "a", "b"]), owners: new Map([["y", 2], ["x", 1]]) }
      })
      expect(seen).toEqual(["a", "b", "c", "owner:x", "owner:y"])
    }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory)))

  effect("joins equal sets and maps in any insertion order as one execution", () =>
    Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      let runs = 0
      yield* engine.register(Tagged, () => Effect.sync(() => (runs++, [])))
      yield* engine.execute(Tagged, {
        executionId: "tagged-join",
        payload: { tags: new Set(["b", "a"]), owners: new Map([["y", 2], ["x", 1]]) }
      })
      const joined = yield* engine.execute(Tagged, {
        executionId: "tagged-join",
        payload: { tags: new Set(["a", "b"]), owners: new Map([["x", 1], ["y", 2]]) }
      }).pipe(Effect.exit)
      expect(Exit.isSuccess(joined)).toBe(true)
      expect(runs).toBe(1)
      const other = yield* engine.execute(Tagged, {
        executionId: "tagged-join",
        payload: { tags: new Set(["a"]), owners: new Map() }
      }).pipe(Effect.exit)
      expect(Exit.isFailure(other) && Cause.hasDies(other.cause)).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory)))
})
