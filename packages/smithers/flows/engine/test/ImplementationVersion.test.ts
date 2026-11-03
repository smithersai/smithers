import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, Interpreter, StepIdentity } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { actionKey, ordinalScope } from "../src/FlowEngine/ActionKey.vibe"
import { withCrypto } from "./Crypto.ts"
import { layerDurable, makeLog } from "./DurableLogEngine.ts"

describe("implementation version reuse", () => {
  it.effect("refuses unversioned reusable handlers before either implementation runs", () =>
    withCrypto(Effect.gen(function*() {
      const log = makeLog()
      let calls = 0
      const declaration = Action.make("ImplementationVersion/legacy", {
        payload: {},
        success: Schema.String,
        idempotencyKey: "same-input"
      })
      const flow = Flow.make("ImplementationVersion/legacy-flow", {
        payload: {},
        success: Schema.String,
        error: Interpreter.InterpreterError,
        body: Node.capture({ action: declaration.name, implementationVersion: "test/v1" }, () => declaration.call({}))
      })
      const run = (executionId: string, output: string) =>
        flow.execute({}, { executionId }).pipe(
          Effect.provide(
            Layer.merge(
              Interpreter.layer(flow, { callbackIdentity: "stable" }),
              declaration.toLayer(() =>
                Effect.sync(() => {
                  calls++
                  return output
                })
              )
            ).pipe(Layer.provide(Action.layerImplementations), Layer.provideMerge(layerDurable(log)))
          ),
          Effect.provideService(Action.CurrentCacheEnvironment, { layers: ["same-host"], capabilities: {} })
        )
      for (const [executionId, output] of [["legacy-first", "old behavior"], ["legacy-second", "new behavior"]]) {
        const exit = yield* Effect.exit(run(executionId!, output!))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toMatchObject({ code: "missing_implementation_version" })
        }
      }
      expect(calls).toBe(0)
      expect(log.actionOutcomes.size).toBe(0)
    })))
})

for (const idempotencyKey of ["input-1", { request: "input-1" }] as const) {
  it.effect(`versions recorded reuse for ${typeof idempotencyKey} identities across engine reconstruction`, () =>
    withCrypto(Effect.gen(function*() {
      const log = makeLog()
      let calls = 0
      const run = (version: string, output: string, executionId: string) => {
        const operation = Action.make("ImplementationVersion/versioned", {
          payload: {},
          success: Schema.String,
          idempotencyKey,
          implementationVersion: version
        })
        const flow = Flow.make("ImplementationVersion/versioned-flow", {
          payload: {},
          success: Schema.String,
          body: Node.capture({ action: operation.name, implementationVersion: "fixture/v1" }, () => operation.call({}))
        })
        return flow.execute({}, { executionId }).pipe(
          Effect.provide(
            Interpreter.layerWithImplementations(
              flow,
              operation.toLayer(() =>
                Effect.sync(() => {
                  calls++
                  return output
                }), { implementationVersion: version })
            ).pipe(Layer.provideMerge(layerDurable(log)))
          ),
          Effect.provideService(Action.CurrentCacheEnvironment, { layers: ["same-host"], capabilities: {} })
        )
      }
      expect(yield* run("implementation/v1", "old behavior", "versioned-first")).toBe("old behavior")
      expect(yield* run("implementation/v1", "replacement declared compatible", "versioned-second")).toBe(
        "old behavior"
      )
      expect(calls).toBe(1)
      expect(yield* run("implementation/v2", "new behavior", "versioned-third")).toBe("new behavior")
      expect(calls).toBe(2)
      expect(yield* run("implementation/v1", "old compatible handler", "versioned-fourth")).toBe("old behavior")
      expect(calls).toBe(2)
      expect(log.executions.size).toBe(4)
      expect(log.actionOutcomes.size).toBe(2)
    })))
}

it.effect("keeps legacy key bytes and versions both sealed keys and framed invocation scopes", () =>
  withCrypto(Effect.gen(function*() {
    const operation = (version?: string, name = "keyed", idempotencyKey: Action.IdempotencyKey | undefined = "input") =>
      Action.make({
        name,
        success: Schema.String,
        implementationVersion: version,
        idempotencyKey,
        execute: Effect.succeed("ok")
      })
    const legacy = operation()
    const oldScope = yield* StepIdentity.allocationScope({
      kind: "action",
      name: "keyed",
      idempotency: "input",
      site: "root.action"
    })
    expect(yield* ordinalScope(legacy, "root.action")).toBe(oldScope)
    const one = operation("v1")
    const two = operation("v2")
    const oneScope = yield* ordinalScope(one, "root.action")
    const twoScope = yield* ordinalScope(two, "root.action")
    expect(oneScope).toBe(`${oldScope}/v:2:v1`)
    expect(twoScope).not.toBe(oneScope)
    expect(yield* actionKey(one, "run", 1, undefined, oneScope)).not.toBe(
      yield* actionKey(two, "run", 1, undefined, twoScope)
    )
    const environment = { layers: [], capabilities: {} }
    for (const tier of ["sealed", "compensable", "irreversible"] as const) {
      const left = Action.make({ name: "ordinal", tier, implementationVersion: "v1", execute: Effect.void })
      const right = Action.make({ name: "ordinal", tier, implementationVersion: "v2", execute: Effect.void })
      const leftScope = yield* ordinalScope(left)
      const rightScope = yield* ordinalScope(right)
      expect(yield* actionKey(left, "run", 1, environment, leftScope)).not.toBe(
        yield* actionKey(right, "run", 1, environment, rightScope)
      )
    }
    // Caller-owned object keys remain rename-stable, including when versioned.
    const first = operation("v1", "old-name", { request: "one", implementationVersion: "caller-cannot-mask" })
    const renamed = operation("v1", "new-name", { request: "one", implementationVersion: "caller-cannot-mask" })
    const changed = operation("v2", "new-name", { request: "one", implementationVersion: "caller-cannot-mask" })
    const keyOf = (action: typeof first) => actionKey(action, "run", 1, environment, "unused")
    expect(yield* keyOf(first)).toBe(yield* keyOf(renamed))
    expect(yield* keyOf(first)).not.toBe(yield* keyOf(changed))
    // Length framing prevents a site suffix from impersonating a version.
    expect(yield* ordinalScope(operation(), "root.action/v:2:v1")).not.toBe(oneScope)
    expect(yield* ordinalScope(operation("v:2:v1"), "root.action")).not.toBe(oneScope)
  })))
