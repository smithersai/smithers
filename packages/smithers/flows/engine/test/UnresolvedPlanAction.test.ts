/**
 * N-06: a plan action with no implementation wired up reports the
 * `InterpreterError` that names the action.
 *
 * The interpreter already refuses such a graph with an `InterpreterError`
 * whose message names the action and the wiring mistake. The engine's register
 * seam then validated that failure against the flow's declared error schema
 * and `orDie`d the mismatch, so what reached the caller was
 * `Die(InvalidType(<Never>))`: the composition's one real diagnostic replaced
 * by a schema issue about a schema nobody wrote. The refusal now travels as
 * the DEFECT itself. It stays a defect because no flow declares it, and a
 * durable run has to encode its settled exit through the flow's own error
 * schema: delivering the refusal as a typed failure instead is unencodable and
 * strands the run row (`packages/smithers/flows/engine-store/test/UnresolvedActionSettles.test.ts`).
 * Both engines are pinned, because the seam is shared and only the driver
 * underneath it differs.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"
import { layerDurable, makeLog } from "./DurableLogEngine.ts"
import { effect } from "./Harness.ts"

const Unimplemented = Action.make("UnresolvedPlanAction/Unimplemented", {
  payload: { id: Schema.String },
  success: Schema.Void
})

/** A flow declaring NO error schema: the shape the mismatch used to erase. */
const Undeclared = Flow.make("UnresolvedPlanAction/undeclared", {
  payload: { id: Schema.String },
  success: Schema.Void,
  body: (payload) => Unimplemented.call(payload)
})

/** A flow that declares an error of its own, which the refusal is still not. */
const Declared = Flow.make("UnresolvedPlanAction/declared", {
  payload: { id: Schema.String },
  success: Schema.Void,
  error: Schema.String,
  body: (payload) => Unimplemented.call(payload)
})

/**
 * The interpreter is wired WITHOUT the action's implementation layer, which is
 * the composition mistake under test.
 */
const wired = (flow: Flow.Any, engine: Layer.Layer<any>) =>
  Interpreter.layer(flow as never).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(engine)
  )

const refusal = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) as { readonly _tag?: string; readonly message?: string } : undefined

/** Whether the refusal arrived as a defect rather than a declared failure. */
const died = (exit: Exit.Exit<unknown, unknown>) => Exit.isFailure(exit) && Cause.hasDies(exit.cause)

describe("a plan action with no implementation", () => {
  effect("reports the refusal on the memory engine, naming the action", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(Undeclared.execute({ id: "x" }, { executionId: "memory-undeclared" }))
      expect(died(exit)).toBe(true)
      expect(refusal(exit)).toMatchObject({
        _tag: "@smthrs/flow/InterpreterError",
        code: "unresolved_action",
        flow: "UnresolvedPlanAction/undeclared"
      })
      expect(refusal(exit)?.message).toContain(Unimplemented.name)
    }).pipe(Effect.provide(wired(Undeclared as never, FlowEngine.layerMemory))))

  effect("reports the refusal on a durable engine, naming the action", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(Undeclared.execute({ id: "x" }, { executionId: "durable-undeclared" }))
      expect(died(exit)).toBe(true)
      expect(refusal(exit)).toMatchObject({
        _tag: "@smthrs/flow/InterpreterError",
        code: "unresolved_action"
      })
      expect(refusal(exit)?.message).toContain(Unimplemented.name)
    }).pipe(Effect.provide(wired(Undeclared as never, layerDurable(makeLog())))))

  effect("names the action for a flow that declares an error schema of its own", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(Declared.execute({ id: "x" }, { executionId: "memory-declared" }))
      expect(died(exit)).toBe(true)
      expect(refusal(exit)).toMatchObject({
        _tag: "@smthrs/flow/InterpreterError",
        code: "unresolved_action",
        flow: "UnresolvedPlanAction/declared"
      })
    }).pipe(Effect.provide(wired(Declared as never, FlowEngine.layerMemory))))
})
