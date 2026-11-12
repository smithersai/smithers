import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { withCrypto } from "./Crypto.ts"
import { layerMemory } from "./MemoryFlowRuntime.ts"

const flow = Flow.make("ExecutionIdentityConflict/authoring", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: () => Node.succeed(1)
})
const conflict = new FlowRuntime.ExecutionIdentityConflict({
  executionId: "existing",
  field: "payload",
  status: "running",
  expected: "first",
  actual: "second",
  message: "cannot reuse"
})
const defect = new Error("unrelated defect")
// This package owns authoring, not execution. Override only its runtime port;
// the real memory and SQLite admission behavior is covered in engine packages.
const failing = (cause: Cause.Cause<FlowRuntime.StoreUnavailable>, called: () => void = () => {}) =>
  Layer.effect(
    FlowRuntime.FlowRuntime,
    Effect.map(FlowRuntime.FlowRuntime, (runtime) =>
      FlowRuntime.FlowRuntime.of({
        ...runtime,
        execute: () => Effect.sync(called).pipe(Effect.andThen(Effect.failCause(cause)))
      }))
  ).pipe(Layer.provide(layerMemory))

const observe = (cause: Cause.Cause<never>) =>
  withCrypto(
    flow.execute({ value: 1 }, { executionId: "existing" }).pipe(
      Effect.exit,
      Effect.provide(failing(cause)),
      Effect.scoped
    )
  )

describe("start and ensure admission refusals", () => {
  // `start` and `ensure` are `execute` with `discard: true`, so they fail the
  // ways admission fails. `ensure` exists to reuse a key, and reusing it with
  // a different payload is the engine's identity conflict.
  it("declares the admission failures execute declares", () => {
    type Declared = Effect.Error<ReturnType<typeof flow.start>>
    type Ensured = Effect.Error<ReturnType<typeof flow.ensure>>
    type Discarded = Effect.Error<ReturnType<typeof flow.execute<true>>>
    expectTypeOf<Declared>().toEqualTypeOf<Discarded>()
    expectTypeOf<Ensured>().toEqualTypeOf<Discarded>()
    expectTypeOf<FlowRuntime.ExecutionIdentityConflict>().toExtend<Declared>()
    expectTypeOf<FlowRuntime.StoreUnavailable>().toExtend<Declared>()
  })

  it.effect("ensure fails with the typed identity conflict a handler can name", () =>
    Effect.gen(function*() {
      const outcome = yield* withCrypto(
        flow.ensure({ value: 2 }, { key: "shared" }).pipe(
          Effect.catchTag("@smthrs/engine/ExecutionIdentityConflict", (error) => Effect.succeed(error.field)),
          Effect.exit,
          Effect.provide(failing(Cause.die(conflict))),
          Effect.scoped
        )
      )
      expect(outcome).toEqual(Exit.succeed("payload"))
    }))

  it.effect("start fails with the typed store outage a handler can name", () =>
    Effect.gen(function*() {
      const unavailable = new FlowRuntime.StoreUnavailable({ executionId: "fresh" })
      const outcome = yield* withCrypto(
        flow.start({ value: 1 }).pipe(
          Effect.catchTag("@smthrs/flow/StoreUnavailable", (error) => Effect.succeed(error.executionId)),
          Effect.exit,
          Effect.provide(failing(Cause.fail(unavailable))),
          Effect.scoped
        )
      )
      expect(outcome).toEqual(Exit.succeed("fresh"))
    }))
})

describe("execute admission refusal conversion", () => {
  it.effect("converts the sole identity defect to the same typed failure", () =>
    Effect.gen(function*() {
      const exit = yield* observe(Cause.die(conflict))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(false)
        expect(exit.cause.reasons.find(Cause.isFailReason)?.error).toBe(conflict)
      }
    }))

  for (
    const [name, cause] of [
      ["unrelated defect", Cause.die(defect)],
      ["conflict combined with another defect", Cause.combine(Cause.die(conflict), Cause.die(defect))],
      ["conflict combined with interruption", Cause.combine(Cause.die(conflict), Cause.interrupt(17))],
      ["sole interruption", Cause.interrupt(17)]
    ] as const
  ) {
    it.effect(`preserves ${name} without hiding a cause`, () =>
      Effect.gen(function*() {
        const exit = yield* observe(cause)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(exit.cause.reasons).toHaveLength(cause.reasons.length)
          for (const [index, original] of cause.reasons.entries()) {
            const observed = exit.cause.reasons[index]!
            expect(observed._tag).toBe(original._tag)
            if (Cause.isDieReason(original)) {
              expect(Cause.isDieReason(observed) && observed.defect).toBe(original.defect)
            } else if (Cause.isInterruptReason(original)) {
              expect(Cause.isInterruptReason(observed) && observed.fiberId).toBe(original.fiberId)
            }
          }
        }
      }))
  }

  it.effect("rejects invalid payload as SchemaError before contacting the runtime", () =>
    Effect.gen(function*() {
      let calls = 0
      const exit = yield* withCrypto(
        flow.execute({ value: "invalid" as unknown as number }, {
          executionId: "existing"
        }).pipe(Effect.exit, Effect.provide(failing(Cause.die(conflict), () => calls++)), Effect.scoped)
      )
      expect(calls).toBe(0)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(false)
        expect(exit.cause.reasons.find(Cause.isFailReason)?.error).toBeInstanceOf(Schema.SchemaError)
      }
    }))
})
