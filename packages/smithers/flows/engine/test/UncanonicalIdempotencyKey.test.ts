import type * as Crypto from "effect/Crypto"
/**
 * Issue #151: forcing key-schema decoders at the four derivation sites turned
 * a typed canonicalization error into an untyped defect that
 * killed the fiber. The caller-owned sites now surface a typed, non-retryable
 * `Action.UncanonicalIdempotencyKey` naming the offending path (delivered
 * through the recorded completion exit, the same channel RetryPolicy's
 * typed terminal errors use), and the engine-generated ordinal sites go
 * through `StepIdentity.invocationKey`, which preserves the typed error for the
 * impossible invariant violation instead of discarding it.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as StepIdentity from "@smthrs/flow/StepIdentity"
import { Cause, Effect, Exit, Layer, Schema, SchemaIssue } from "effect"
import { schemaErrorPath } from "../src/FlowEngine/ActionKey.ts"
import { FlowEngine } from "../src/index.ts"
import { invocationKey, runSync, withCrypto } from "./Crypto.ts"
import { effect } from "./Harness.ts"

const identityWith = (body: unknown): Action.IdempotencyKey => ({ body } as Action.IdempotencyKey)

const dieOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (!Exit.isFailure(exit)) return undefined
  const reason = exit.cause.reasons.find(Cause.isDieReason)
  return reason?.defect
}

const runRejected = (tier: "sealed" | "compensable", body: unknown) => {
  let executions = 0
  const action = Action.make({
    name: `Uncanonical/${tier}`,
    success: Schema.Number,
    tier,
    idempotencyKey: identityWith(body),
    execute: Effect.sync(() => {
      executions++
      return 1
    })
  })
  const flowActionDeclaration = Action.make(`Uncanonical/${tier}-flow` + "/action", {
    payload: { id: Schema.String },
    success: Schema.Number
  })
  const flow = Flow.make(`Uncanonical/${tier}-flow`, {
    payload: { id: Schema.String },
    success: Schema.Number,
    body: (payload) => flowActionDeclaration.call(payload)
  })
  const layer = Layer.mergeAll(flowActionDeclaration.toLayer(() => action), Interpreter.layer(flow)).pipe(
    Layer.provideMerge(Action.layerImplementations)
  ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
  return Effect.gen(function*() {
    const exit = yield* flow.execute({ id: "x" }, { executionId: `run-${tier}` }).pipe(Effect.exit)
    return { exit, executions }
  }).pipe(Effect.provide(layer))
}

describe("rejected declaration material surfaces typed, not as fiber death (issue #151)", () => {
  effect("non-JSON object identity fails typed", () =>
    Effect.gen(function*() {
      const outcome = yield* runRejected("sealed", { count: 1n })
      const defect = dieOf(outcome.exit)
      expect(defect).toBeInstanceOf(Action.UncanonicalIdempotencyKey)
      const error = defect as Action.UncanonicalIdempotencyKey
      expect(error.code).toBe("uncanonical_idempotency_key")
      expect(error.actionName).toBe("Uncanonical/sealed")
      expect(error.reason).toBe("canonicalize_failed")
      // This is the offending path inside the declared identity. The
      // canonical schema reports this particular refusal at its root.
      expect(error.path).toBe("$")
      expect(outcome.executions).toBe(0)
    }))

  effect(
    "compensable identity rejection uses the same typed path before the action runs",
    () =>
      Effect.gen(function*() {
        const outcome = yield* runRejected("compensable", { count: 1n })
        const defect = dieOf(outcome.exit)
        expect(defect).toBeInstanceOf(Action.UncanonicalIdempotencyKey)
        expect(defect).toMatchObject({ path: "$", reason: "canonicalize_failed" })
        expect(outcome.executions).toBe(0)
      })
  )

  it("walks the first schema-issue leaf and renders accumulated pointer segments", () => {
    const leaf = new SchemaIssue.InvalidValue()
    const nested = new Schema.SchemaError(
      new SchemaIssue.Pointer(["body"], new SchemaIssue.Pointer(["items", 0, "count"], leaf))
    )
    expect(schemaErrorPath(nested)).toBe("$.body.items[0].count")

    const wrapped = new Schema.SchemaError(
      new SchemaIssue.Composite(Schema.String.ast, [
        new SchemaIssue.AnyOf(Schema.Union([Schema.String, Schema.Number]).ast as never, [
          new SchemaIssue.Encoding(
            Schema.String.ast,
            new SchemaIssue.Filter(Schema.String.ast as never, new SchemaIssue.Pointer(["nested"], leaf))
          )
        ])
      ])
    )
    expect(schemaErrorPath(wrapped)).toBe("$.nested")
  })

  it("falls back to the root when no path is available or the walk reaches its bound", () => {
    expect(schemaErrorPath(new Schema.SchemaError(new SchemaIssue.InvalidValue()))).toBe("$")
    expect(
      schemaErrorPath(
        new Schema.SchemaError(
          new SchemaIssue.AnyOf(Schema.Union([Schema.String, Schema.Number]).ast as never, [])
        )
      )
    ).toBe("$")

    let issue: SchemaIssue.Issue = new SchemaIssue.InvalidValue()
    for (let index = 0; index < 70; index++) {
      issue = new SchemaIssue.Encoding(Schema.String.ast, issue)
    }
    expect(schemaErrorPath(new Schema.SchemaError(issue))).toBe("$")
  })
})

describe("StepIdentity typed derivations (issue #151)", () => {
  it("allocationScope returns a typed SchemaError for rejected JSON material", () => {
    const error = runSync(Effect.flip(StepIdentity.allocationScope({
      kind: "action",
      name: "op",
      idempotency: identityWith({ count: 1n })
    })))
    expect(error._tag).toBe("SchemaError")
  })

  it("allocationScope stays total for string and absent idempotency material", () => {
    const keyless = runSync(StepIdentity.allocationScope({ kind: "internal", name: "op" }))
    const keyed = runSync(StepIdentity.allocationScope({
      kind: "internal",
      name: "op",
      idempotency: "queue:orders"
    }))
    expect(keyless).toBe("internal/2:op")
    expect(keyed).toMatch(/^internal\/2:op\/s:/)
  })

  it("invocationKey preserves the typed CanonicalizeError on the impossible invariant violation", () => {
    expect(runSync(Effect.flip(StepIdentity.invocationKey({
      runId: "run",
      ordinal: Number.POSITIVE_INFINITY,
      tier: "unsealed"
    })))).toEqual(expect.objectContaining({ _tag: "SchemaError" }))
    expect(runSync(StepIdentity.invocationKey({ runId: "run", ordinal: 1, tier: "unsealed" }))).toBe(
      invocationKey({ runId: "run", ordinal: 1, tier: "unsealed" })
    )
  })
})
