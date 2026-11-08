import { expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, Graph, Interpreter } from "@smthrs/flow"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { withCrypto } from "./Crypto.ts"
import { layerWired, makeInstance, makeMemoryState } from "./MemoryFlowRuntime.ts"

const Crash = Action.make("defect-evidence/crash", { payload: {}, success: Schema.Number, error: Schema.String })
const Host = Flow.make("defect-evidence/host", {
  payload: {},
  success: Schema.Number,
  error: Schema.String,
  body: () => Crash.call({})
})
const failure = { _tag: "StorageFailure", code: "closed", message: "unavailable", cause: { _tag: "SocketError" } }

it("retains named errors and primitive causes without inventing diagnostics", () => {
  expect(Interpreter.defectOf(Cause.die({ code: "ECONNRESET", message: "disconnected" }))).toEqual({
    tag: "ECONNRESET",
    message: "disconnected"
  })
  expect(Interpreter.defectOf(Cause.die({ code: "invalid code", message: "unclassified" }))).toEqual({
    tag: "defect",
    message: "unclassified"
  })
  expect(Interpreter.defectOf(Cause.die(new TypeError("invalid")))).toEqual({ tag: "TypeError", message: "invalid" })
  expect(Interpreter.defectOf(Cause.die({ name: "invalid name", cause: 7 }))).toEqual({ tag: "defect", message: "" })
  expect(Interpreter.defectOf(Cause.die({ message: "outer", cause: "inner" }))).toEqual({
    tag: "defect",
    message: "outer: inner"
  })
})

for (const recording of ["defect", "interrupt"] as const) {
  it.effect(`preserves the node failure when its diagnostic record ends with ${recording}`, () =>
    Effect.gen(function*() {
      let attempted = 0
      const memory = makeMemoryState()
      const exit = yield* withCrypto(
        Effect.exit(Interpreter.interpret(Host, {})).pipe(
          Effect.updateService(FlowRuntime.FlowRuntime, (runtime) => ({
            ...runtime,
            recordNode: (record) => {
              if (record._tag === "NodeSettled" && record.outcome === "failed") {
                attempted++
                return recording === "interrupt" ? Effect.interrupt : Effect.die("record unavailable")
              }
              return runtime.recordNode!(record)
            }
          })),
          Effect.provideService(FlowRuntime.FlowInstance, makeInstance(Host, "failure-record")),
          Effect.provide(layerWired(Crash.toLayer(() => Effect.die(failure)), memory))
        )
      )
      expect(attempted).toBeGreaterThan(0)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        if (recording === "interrupt") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        else {expect(Interpreter.defectOf(exit.cause)).toMatchObject({
            tag: "StorageFailure",
            code: "closed",
            causes: ["SocketError"]
          })}
      }
      expect(
        memory.nodeRecords.map(({ record }) => record).filter((record) =>
          record._tag === "NodeSettled" && record.outcome === "failed"
        )
      )
        .toEqual([])
    }))
}

it.effect("keeps one settlement when a cause carries a typed failure and a defect", () =>
  Effect.gen(function*() {
    const memory = makeMemoryState()
    const exit = yield* withCrypto(
      Effect.exit(Interpreter.interpret(Host, {})).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, makeInstance(Host, "mixed-failure")),
        Effect.provide(
          layerWired(
            Crash.toLayer(() => Effect.failCause(Cause.combine(Cause.fail("refused"), Cause.die(failure)))),
            memory
          )
        )
      )
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const settlements = memory.nodeRecords.map(({ record }) => record).filter((record) =>
      record._tag === "NodeSettled" && record.outcome === "failed"
    )
    expect(settlements).toHaveLength(Graph.nodes(Graph.build(Host, {})).length)
    expect(new Set(settlements.map((record) => record._tag === "NodeSettled" ? record.nodeId : undefined)).size).toBe(
      settlements.length
    )
    if (Exit.isFailure(exit)) {
      expect(Interpreter.defectOf(exit.cause)).toMatchObject({ tag: "StorageFailure", code: "closed" })
    }
  }))
