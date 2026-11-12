import { expect } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Logger, References, Schema } from "effect"
import type { Cause } from "effect"
import { FlowEngine } from "../src/index.ts"
import { renderDiagnostic } from "../src/internal/Diagnostic.ts"
import { effect } from "./Harness.ts"

const observeDiscard = (body: Effect.Effect<never, string>, error: typeof Schema.Never | typeof Schema.String) =>
  Effect.scoped(Effect.gen(function*() {
    const logs: Array<{
      message: unknown
      cause: Cause.Cause<unknown>
      level: string
      annotations: Readonly<Record<string, unknown>>
    }> = []
    const logger = Logger.make((entry) =>
      logs.push({
        message: entry.message,
        cause: entry.cause,
        level: entry.logLevel,
        annotations: entry.fiber.getRef(References.CurrentLogAnnotations)
      })
    )
    const flow = Flow.make("discard-observer/flow", {
      payload: {},
      success: Schema.Void,
      error,
      body: () => Node.succeed(undefined)
    })
    const engine = yield* FlowRuntime.FlowRuntime
    yield* engine.register(flow, () => body)
    const executionId = yield* engine.execute(flow, { executionId: "discard-failure", payload: {}, discard: true })
      .pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])))
    for (let turn = 0; turn < 100 && logs.length === 0; turn++) yield* Effect.yieldNow
    expect(executionId).toBe("discard-failure")
    expect(logs).toHaveLength(1)
    expect(logs[0]!.level).toBe("Error")
    expect(logs[0]!.cause.reasons).toEqual([])
    expect(logs[0]!.annotations).toEqual(expect.objectContaining({
      flow: flow._tag,
      executionId
    }))
    return logs[0]!
  })).pipe(Effect.provide(FlowEngine.layerMemory))

effect("discarded defects log a redacted diagnostic with the execution identity", () =>
  Effect.gen(function*() {
    const failure = new Error("discarded body failed: Bearer discard-secret-XYZ123")
    const log = yield* observeDiscard(Effect.die(failure), Schema.Never)
    expect(log.annotations).toMatchObject({ failureKind: "defect", reasonCount: 1 })
    const message = log.message
    expect(message).toEqual(["A discarded flow failed", renderDiagnostic(failure)])
    expect(JSON.stringify(message)).toContain("[REDACTED")
    expect(JSON.stringify(message)).not.toContain("discard-secret-XYZ123")
  }))

effect("discarded declared failures log no user content", () =>
  Effect.gen(function*() {
    const log = yield* observeDiscard(Effect.fail("private customer content"), Schema.String)
    expect(log.annotations).toMatchObject({ failureKind: "failure", reasonCount: 1 })
    expect(log.message).toEqual(["A discarded flow failed"])
  }))

effect("a discarded failure with a dying finalizer logs no user content", () =>
  Effect.gen(function*() {
    const failure = new Error("cleanup failed: Bearer discard-secret-XYZ123")
    const log = yield* observeDiscard(
      Effect.fail("private customer content").pipe(Effect.ensuring(Effect.die(failure))),
      Schema.String
    )
    expect(log.annotations).toMatchObject({ failureKind: "defect", reasonCount: 2 })
    expect(log.message).toEqual(["A discarded flow failed"])
  }))

effect("discarded interruptions retain a safe reason without logging a cause", () =>
  Effect.gen(function*() {
    const log = yield* observeDiscard(Effect.interrupt, Schema.Never)
    expect(log.annotations).toMatchObject({ failureKind: "interruption", reasonCount: 1 })
    expect(log.message).toEqual(["A discarded flow failed"])
  }))
