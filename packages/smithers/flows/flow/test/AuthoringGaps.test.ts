// Deep reviewed and polished by a human on 2026-08-10.

/**
 * The authoring-surface corners the behavioural suites do not reach: the
 * cache-environment filter, the context references' defaults, the internal
 * idempotency-key scoping forms, infrastructure-interrupt exhaustion, the
 * flow scope helpers, and the waiting annotation a durable driver reads.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Cause, Context, Effect, Exit, Fiber, Latch, Layer, Option, Schedule, Schema, Scope } from "effect"
import type * as Crypto from "effect/Crypto"
import { withCrypto } from "./Crypto.ts"
import { layerMemory, layerWired, makeInstance } from "./MemoryFlowRuntime.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it.effect(name, () => withCrypto(body()))

describe("FlowRuntime service identity", () => {
  it("matches its defining module path", () => {
    expect(FlowRuntime.FlowRuntime.key).toBe("@smthrs/flow/FlowRuntime/FlowRuntime")
  })
})

/** The one step the host flow is made of; each case supplies its body. */
const Block = Action.make("Gaps/Block", {
  payload: { id: Schema.String },
  success: Schema.Void
})

const Host = Flow.make("Gaps/Host", {
  payload: { id: Schema.String },
  success: Schema.Void,
  idempotencyKey: ({ id }) => id,
  body: (payload) => Block.call(payload)
})

/** The host flow, wired to run `execute` as its single declared step. */
const hosted = (
  execute: () => Effect.Effect<void, never, Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance>
): Layer.Layer<
  Action.Requirement<"Gaps/Block"> | FlowRuntime.FlowRuntime | Action.Implementations,
  never,
  Crypto.Crypto
> => layerWired(Layer.mergeAll(Block.toLayer(execute), Interpreter.layer(Host)))

describe("Action.CacheEnvironment", () => {
  it("accepts a complete environment and rejects an empty capability name", () => {
    const decode = Schema.decodeUnknownExit(Action.CacheEnvironment)
    expect(
      Exit.isSuccess(decode({ layers: ["node@22"], capabilities: { net: ["dns"] } }))
    ).toBe(true)
    expect(
      Exit.isFailure(decode({ layers: ["node@22"], capabilities: { "": ["dns"] } }))
    ).toBe(true)
  })

  effect("layerCacheEnvironment publishes it, and the reference defaults to absent", () =>
    Effect.gen(function*() {
      expect(yield* Action.CurrentCacheEnvironment).toBeUndefined()
      expect(yield* Action.CurrentOrdinal).toBeUndefined()
      expect(yield* Action.CurrentAttempt).toBe(1)
      const environment: Action.CacheEnvironment = {
        layers: ["node@22"],
        capabilities: { net: ["dns"] }
      }
      const seen = yield* Action.CurrentCacheEnvironment.pipe(
        Effect.provide(Action.layerCacheEnvironment(environment))
      )
      expect(seen).toEqual(environment)
    }))

  it("preserves duplicate values and distinct Unicode capability names", () => {
    const decoded = Schema.decodeUnknownExit(Action.CacheEnvironment)({
      layers: ["node@22", "node@22", "工具@1"],
      capabilities: {
        net: ["dns", "dns"],
        "café": ["read"],
        "café": ["write"],
        "🧪": ["run"]
      }
    })

    expect(Exit.isSuccess(decoded)).toBe(true)
    if (!Exit.isSuccess(decoded)) return
    expect(decoded.value.layers).toEqual(["node@22", "node@22", "工具@1"])
    expect(decoded.value.capabilities.net).toEqual(["dns", "dns"])
    expect(Object.keys(decoded.value.capabilities)).toContain("café")
    expect(Object.keys(decoded.value.capabilities)).toContain("café")
  })
})

describe("Action.idempotencyKey", () => {
  const withInstance = <A, E>(effect: Effect.Effect<A, E, FlowRuntime.FlowInstance | Crypto.Crypto>) =>
    Effect.provideService(effect, FlowRuntime.FlowInstance, makeInstance(Host, "internal-keys"))

  effect(
    "scopes allocations by the declared parent, the attempt, or neither",
    () =>
      withInstance(Effect.gen(function*() {
        const plain = yield* Action.idempotencyKey("offer")
        const alsoPlain = yield* Action.idempotencyKey("offer")
        const scoped = yield* Action.idempotencyKey("offer", { parentScope: "queue:a" })
        const byAttempt = yield* Action.idempotencyKey("offer", { includeAttempt: true })
        // Distinct allocations of one scope are ordinal-ordered, and distinct
        // scopes never collide.
        expect(plain).not.toBe(alsoPlain)
        expect(new Set([plain, alsoPlain, scoped, byAttempt]).size).toBe(4)
      }))
  )

  effect("keeps concurrent parent scopes on independent deterministic counters", () =>
    Effect.gen(function*() {
      const baselineInstance = makeInstance(Host, "concurrent-keys")
      const baseline = yield* Effect.all([
        Action.idempotencyKey("left", { parentScope: "scope:left" }),
        Action.idempotencyKey("right", { parentScope: "scope:right" })
      ]).pipe(Effect.provideService(FlowRuntime.FlowInstance, baselineInstance))

      const concurrentInstance = makeInstance(Host, "concurrent-keys")
      const release = yield* Latch.make()
      const left = yield* Effect.forkChild(
        release.await.pipe(
          Effect.andThen(Action.idempotencyKey("left", { parentScope: "scope:left" })),
          Effect.provideService(FlowRuntime.FlowInstance, concurrentInstance)
        )
      )
      const right = yield* Effect.forkChild(
        release.await.pipe(
          Effect.andThen(Action.idempotencyKey("right", { parentScope: "scope:right" })),
          Effect.provideService(FlowRuntime.FlowInstance, concurrentInstance)
        )
      )
      yield* release.open
      const concurrent = yield* Effect.all([Fiber.join(left), Fiber.join(right)])

      expect(concurrent).toEqual(baseline)
      expect(new Set(concurrent).size).toBe(2)
    }))

  effect("combines the declaration name with parent-scope precedence over the attempt", () =>
    Effect.gen(function*() {
      const withBoth = yield* Action.idempotencyKey("offer", {
        includeAttempt: true,
        parentScope: "queue:parent"
      }).pipe(
        Effect.provideService(Action.CurrentAttempt, 7),
        Effect.provideService(FlowRuntime.FlowInstance, makeInstance(Host, "attempt-parent"))
      )
      const parentOnly = yield* Action.idempotencyKey("renamed diagnostic", {
        parentScope: "queue:parent"
      }).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, makeInstance(Host, "attempt-parent"))
      )
      const attemptOnly = yield* Action.idempotencyKey("offer", { includeAttempt: true }).pipe(
        Effect.provideService(Action.CurrentAttempt, 7),
        Effect.provideService(FlowRuntime.FlowInstance, makeInstance(Host, "attempt-parent"))
      )

      expect(withBoth).not.toBe(parentOnly)
      expect(attemptOnly).not.toBe(parentOnly)
    }))
})

describe("Action infrastructure-interrupt retry", () => {
  effect("exhaustion dies with the action, real attempt count, and final interrupt", () => {
    let attempts = 0
    const action = Action.make({
      name: "Gaps/infra",
      success: Schema.Void,
      error: Schema.Union([Action.InfraInterrupt, Schema.String]),
      interruptRetryPolicy: Schedule.recurs(2),
      execute: Effect.suspend(() => {
        attempts++
        return Effect.fail(new Action.InfraInterrupt({ reason: "host lost" }))
      })
    })
    const layer = hosted(() => Effect.asVoid(action).pipe(Effect.orDie))
    return Effect.gen(function*() {
      const exit = yield* Host.execute({ id: "infra" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const defect = exit.cause.reasons.find(Cause.isDieReason)?.defect
        expect(defect).toMatchObject({
          _tag: "@smthrs/flow/InfraInterruptRetriesExhausted",
          code: "infra_interrupt_retries_exhausted",
          actionName: "Gaps/infra",
          attempts: 3,
          interrupt: {
            _tag: "@smthrs/flow/InfraInterrupt",
            code: "infra_interrupt",
            reason: "host lost"
          }
        })
      }
      expect(attempts).toBe(3)
    }).pipe(Effect.provide(layer))
  })

  effect("a non-infrastructure failure is propagated untouched", () => {
    let attempts = 0
    const action = Action.make({
      name: "Gaps/other",
      success: Schema.Void,
      error: Schema.String,
      interruptRetryPolicy: Schedule.recurs(2),
      execute: Effect.suspend(() => {
        attempts++
        return Effect.fail("plain")
      })
    })
    const layer = hosted(() => Effect.asVoid(action).pipe(Effect.orDie))
    return Effect.gen(function*() {
      const exit = yield* Host.execute({ id: "other" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        // untouched: the failure the implementation died on, not the
        // exhaustion error the interrupt policy raises for its own kind
        expect(exit.cause.reasons.find(Cause.isDieReason)?.defect).toBe("plain")
        expect(Cause.hasInterrupts(exit.cause)).toBe(false)
      }
      expect(attempts).toBe(1)
    }).pipe(Effect.provide(layer))
  })
})

describe("flow scope helpers", () => {
  effect("scope and provideScope expose the flow lifetime scope", () => {
    let finalized = 0
    const layer = hosted(() =>
      Effect.gen(function*() {
        const flowScope = yield* Flow.scope
        expect(flowScope).toBeDefined()
        yield* Flow.provideScope(
          Effect.flatMap(
            Effect.scope,
            (scope) => Scope.addFinalizer(scope, Effect.sync(() => void finalized++))
          )
        )
        // the scope outlives the step that registered on it: nothing has run yet
        expect(finalized).toBe(0)
      })
    )
    return Effect.gen(function*() {
      yield* Host.execute({ id: "scope" })
      expect(finalized).toBe(1)
    }).pipe(Effect.provide(layer))
  })
})

describe("Flow annotations", () => {
  effect("annotateMerge folds a context into the flow definition, and an uncaptured defect escapes", () => {
    const Defective = Action.make("Gaps/Uncaptured/step", {
      payload: { id: Schema.String },
      success: Schema.Void
    })
    const Uncaptured = Flow.make("Gaps/Uncaptured", {
      payload: { id: Schema.String },
      success: Schema.Void,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Defective.call(payload)
    }).annotateMerge(Context.make(Flow.CaptureDefects, false))
    expect(Uncaptured._tag).toBe("Gaps/Uncaptured")
    const layer = layerWired(
      Layer.mergeAll(Defective.toLayer(() => Effect.die("boom")), Interpreter.layer(Uncaptured))
    )
    return Effect.gen(function*() {
      const exit = yield* Uncaptured.execute({ id: "defect" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      // `execute` reports a failed exit under either setting, so the annotation
      // is read where the two differ: an uncaptured defect fails the round's
      // own fiber, while the captured default settles that round as a
      // `Complete` carrying the die.
      const die = Effect.die("boom") as Effect.Effect<void>
      const uncaptured = yield* Flow.intoResult(die).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, makeInstance(Uncaptured, "uncaptured")),
        Effect.exit
      )
      expect(Exit.isFailure(uncaptured) && Cause.hasDies(uncaptured.cause)).toBe(true)
      const captured = yield* Flow.intoResult(die).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, makeInstance(Host, "captured"))
      )
      expect(captured._tag).toBe("Complete")
      expect(
        captured._tag === "Complete" && Exit.isFailure(captured.exit) &&
          Cause.hasDies(captured.exit.cause)
      ).toBe(true)
    }).pipe(Effect.provide(layer))
  })
})

/** Reads back what `into` persisted, once the effect that wrote it has settled. */
const recordInto = <Success extends Schema.Constraint, Error extends Schema.Constraint>(
  gate: DurableDeferred.DurableDeferred<Success, Error>,
  onRecorded: (result: Option.Option<Exit.Exit<unknown, unknown>>) => void
) =>
<A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.onExit(() =>
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        onRecorded(yield* engine.deferredResult(gate))
      })
    )
  )

/** The record holds exactly one failure reason, carrying `error`. */
const expectRecordedFailure = (
  recorded: Option.Option<Exit.Exit<unknown, unknown>> | undefined,
  error: string
) => {
  const exit = recorded === undefined || Option.isNone(recorded) ? undefined : recorded.value
  expect(exit !== undefined && Exit.isFailure(exit)).toBe(true)
  if (exit === undefined || !Exit.isFailure(exit)) return
  expect(exit.cause.reasons.map((reason) => reason._tag)).toEqual(["Fail"])
  expect(exit.cause.reasons.find(Cause.isFailReason)?.error).toBe(error)
}

describe("DurableDeferred.into", () => {
  effect("strips interrupt reasons from a mixed cause before recording it", () => {
    const gate = DurableDeferred.make("Gaps/mixed", { error: Schema.String })
    let recorded: Option.Option<Exit.Exit<unknown, unknown>> | undefined
    const layer = hosted(() =>
      DurableDeferred.into(
        Effect.failCause(
          Cause.combine(Cause.fail("real"), Cause.interrupt(1))
        ) as Effect.Effect<void, string>,
        gate
      ).pipe(Effect.orDie, recordInto(gate, (result) => void (recorded = result)))
    )
    return Effect.gen(function*() {
      const exit = yield* Host.execute({ id: "mixed" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expectRecordedFailure(recorded, "real")
    }).pipe(Effect.provide(layer))
  })

  effect("a plain failure is recorded verbatim", () => {
    const gate = DurableDeferred.make("Gaps/plain", { error: Schema.String })
    let recorded: Option.Option<Exit.Exit<unknown, unknown>> | undefined
    const layer = hosted(() =>
      DurableDeferred.into(Effect.fail("just failed") as Effect.Effect<void, string>, gate).pipe(
        Effect.orDie,
        recordInto(gate, (result) => void (recorded = result))
      )
    )
    return Effect.gen(function*() {
      const exit = yield* Host.execute({ id: "plain-fail" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expectRecordedFailure(recorded, "just failed")
    }).pipe(Effect.provide(layer))
  })

  effect("preserves a handoff written by the wrapped effect", () =>
    Effect.gen(function*() {
      const instance = makeInstance(Host, "handoff-inside-into")
      const handoff = new Flow.Handoff({ flow: "Gaps/next", payload: { id: "next" } })
      const result = yield* Flow.intoResult(DurableDeferred.into(
        Effect.gen(function*() {
          const current = yield* FlowRuntime.FlowInstance
          current.handoff = handoff
        }),
        DurableDeferred.make("Gaps/handoff-result")
      )).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, instance),
        Effect.provide(layerMemory)
      )
      expect(result).toEqual(handoff)
      expect(instance.handoff).toBe(handoff)
    }))

  effect("an interrupt-only exit records nothing", () => {
    const gate = DurableDeferred.make("Gaps/interrupted", { error: Schema.String })
    let recorded: Option.Option<Exit.Exit<unknown, unknown>> | undefined
    const layer = hosted(() =>
      DurableDeferred.into(Effect.interrupt as Effect.Effect<void, string>, gate).pipe(
        Effect.orDie,
        Effect.onExit(() =>
          Effect.gen(function*() {
            const engine = yield* FlowRuntime.FlowRuntime
            recorded = yield* engine.deferredResult(gate)
          })
        )
      )
    )
    return Effect.gen(function*() {
      const exit = yield* Host.execute({ id: "interrupted" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(recorded).toEqual(Option.none())
    }).pipe(Effect.provide(layer))
  })
})

describe("FlowRuntime.annotateWaiting", () => {
  effect("preserves the declared reason and token when suspending inside into", () =>
    Effect.gen(function*() {
      const instance = makeInstance(Host, "waiting-inside-into")
      const gate = DurableDeferred.make("Gaps/waiting-inside-into")
      const result = yield* Flow.intoResult(DurableDeferred.into(
        Effect.gen(function*() {
          yield* FlowRuntime.annotateWaiting({ reason: "approval", token: "req-into" })
          yield* DurableDeferred.await(gate)
        }),
        DurableDeferred.make("Gaps/waiting-result")
      )).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, instance),
        Effect.provide(layerMemory)
      )
      expect(result._tag).toBe("Suspended")
      expect(instance.waiting).toEqual({ reason: "approval", token: "req-into" })
    }))

  effect("records the declared classification on the instance", () =>
    Effect.gen(function*() {
      const instance = makeInstance(Host, "waiting")
      yield* FlowRuntime.annotateWaiting({ reason: "approval", token: "req-1" }).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, instance)
      )
      expect(instance.waiting).toEqual({ reason: "approval", token: "req-1" })
      yield* FlowRuntime.annotateWaiting(undefined).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, instance)
      )
      expect(instance.waiting).toBeUndefined()
    }))

  it("FlowCycleDetected carries its stable code and path", () => {
    const error = new FlowRuntime.FlowCycleDetected({
      code: "flow_cycle_detected",
      path: ["a", "b"]
    })
    expect(error.code).toBe("flow_cycle_detected")
    expect(error.path).toEqual(["a", "b"])
  })
})
