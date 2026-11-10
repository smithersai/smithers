/** Persisted outcomes rejected by this build fail with a safe typed diagnostic, without printing journal values. */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, JournalDecode } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Exit, Layer, Logger, Metric, References, Schema } from "effect"
import type * as EffectDigest from "effect/crypto/Digest"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"
import { effect } from "./Harness.ts"
import { scriptedEngine } from "./ScriptedEngine.ts"

const flow = Flow.make("RecordedExitSchemaMismatch/flow", {
  payload: { id: Schema.String },
  success: Schema.Number,
  error: Schema.String,
  body: () => Node.succeed(0)
})

describe("a recorded outcome that fails the action's exit schema", () => {
  effect("fails fast with a typed decode error and never logs the recorded payload", () => {
    const logs: Array<
      { readonly message: unknown; readonly logLevel: string; readonly annotations: Readonly<Record<string, unknown>> }
    > = []
    const capture = Logger.make((options) => {
      logs.push({
        message: options.message,
        logLevel: options.logLevel,
        annotations: options.fiber.getRef(References.CurrentLogAnnotations)
      })
    })
    const action = Action.make({
      name: "RecordedExitSchemaMismatch/undeclared-error",
      success: Schema.Number,
      error: Schema.String,
      execute: Effect.die("scripted driver dispatches instead")
    })
    const engine = scriptedEngine({
      // The driver hands back an outcome the action never declared: the error
      // channel is a string, and this one is a number.
      actionExecute: () => Effect.succeed(new Flow.Complete({ exit: Exit.fail(42 as never) })),
      actionRetryOrigin: () => Effect.succeedNone
    })
    return Effect.gen(function*() {
      const metric = Metric.withAttributes(JournalDecode.failures, { stepTag: action.name, boundary: "outcome" })
      const before = (yield* Metric.value(metric)).count
      const exit = yield* Effect.exit(engine.actionExecute(action, 1))
      expect((yield* Metric.value(metric)).count - before).toBe(1)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      const reported = logs.filter((entry) =>
        entry.logLevel === "Error" &&
        String(entry.message).includes("smithers.journal.decode.failed")
      )
      expect(reported.length).toBe(1)
      expect(reported[0]?.annotations["action"]).toBe("RecordedExitSchemaMismatch/undeclared-error")
      expect(reported[0]?.annotations["exit"]).toBeUndefined()
      expect(reported[0]?.annotations["objectId"]).toBe("unknown")
      expect(reported[0]?.annotations["codeVersion"]).toBe("unknown")
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
        _tag: "JournalDecodeError",
        stepTag: action.name,
        objectId: "unknown",
        codeVersion: "unknown"
      })
    }).pipe(
      Effect.provideService(
        FlowRuntime.FlowInstance,
        FlowEngine.makeInstance(flow, "recorded-exit-schema-mismatch-run")
      ),
      Effect.provide(Layer.succeed(FlowRuntime.FlowRuntime)(engine)),
      Effect.provide(Logger.layer([capture]))
    )
  })

  effect("bounds a circular recorded action failure while preserving the schema-mismatch defect", () => {
    const logs: Array<
      { readonly message: unknown; readonly logLevel: string; readonly annotations: Readonly<Record<string, unknown>> }
    > = []
    const capture = Logger.make((options) => {
      logs.push({
        message: options.message,
        logLevel: options.logLevel,
        annotations: options.fiber.getRef(References.CurrentLogAnnotations)
      })
    })
    const action = Action.make({
      name: "RecordedExitSchemaMismatch/circular-error",
      success: Schema.Number,
      error: Schema.String,
      execute: Effect.die("scripted driver dispatches instead")
    })
    const circular: { self?: unknown } = {}
    circular.self = circular
    const engine = scriptedEngine({
      actionExecute: () => Effect.succeed(new Flow.Complete({ exit: Exit.fail(circular as never) }))
    })
    return Effect.gen(function*() {
      const metric = Metric.withAttributes(JournalDecode.failures, { stepTag: action.name, boundary: "outcome" })
      const before = (yield* Metric.value(metric)).count
      const exit = yield* Effect.exit(engine.actionExecute(action, 1))
      expect((yield* Metric.value(metric)).count - before).toBe(1)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      const reported = logs.filter((entry) =>
        entry.logLevel === "Error" &&
        String(entry.message).includes("smithers.journal.decode.failed")
      )
      expect(reported.length).toBe(1)
      expect(reported[0]?.annotations["action"]).toBe("RecordedExitSchemaMismatch/circular-error")
      expect(reported[0]?.annotations["exit"]).toBeUndefined()
      expect(String(reported[0]?.annotations["exit"])).not.toContain("self")
      expect(reported[0]?.annotations["objectId"]).toBe("fixture-object")
      expect(reported[0]?.annotations["codeVersion"]).toBe("rollback-build")
    }).pipe(
      Effect.provideService(
        FlowRuntime.FlowInstance,
        FlowEngine.makeInstance(flow, "recorded-exit-circular-run")
      ),
      Effect.provide(Layer.succeed(FlowRuntime.FlowRuntime)(engine)),
      Effect.provide(Logger.layer([capture])),
      Effect.provideService(JournalDecode.Identity, { objectId: "fixture-object", codeVersion: "rollback-build" })
    )
  })
})
