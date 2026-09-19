import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import { Flow } from "@smthrs/flow"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import { Journal, type StepFact } from "@smthrs/journal"
import { Node } from "@smthrs/plan"
import { Effect, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as EventSink from "../src/EventSink.ts"
import { facts, stores } from "./fixtures/step-trace-stack.ts"

const TraceFlow = Flow.make("test/trace-source-identity", {
  payload: {},
  success: Schema.String,
  error: Journal.JournalError,
  body: () => Node.succeed("done")
})
const opened = new AgentEvent.TurnOpened({
  eventType: "flows.harness.turn-opened.v1",
  seat: "test",
  modelParams: {},
  activeToolNames: [],
  contextDigest: "context"
})
const escaped = "\u0000".repeat(60_000)
const samples = [
  { label: "small result", flowName: "read", value: "same", message: "" },
  { label: "escaped result", flowName: "read", value: escaped, message: "" },
  { label: "escaped fields", flowName: escaped, value: escaped, message: escaped }
]
const cases = samples.flatMap((sample) => (["started", "settled"] as const).map((kind) => ({ ...sample, kind })))
const observed = (ordinal: number, sample: typeof cases[number]) => {
  const identity = new Cell.CallIdentity({
    session: "session",
    frame: 0,
    cell: "cell",
    ordinal,
    declaration: sample.flowName,
    layers: []
  })
  return sample.kind === "started"
    ? new AgentEvent.CellCallStarted({
      eventType: "flows.harness.cell-call-started.v1",
      call: new Cell.Call({
        flowName: sample.flowName,
        input: sample.value,
        capabilities: [],
        effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
        placement: Option.none(),
        identity
      })
    })
    : new AgentEvent.CellCallSettled({
      eventType: "flows.harness.cell-call-settled.v1",
      flowName: sample.flowName,
      identity,
      result: new Cell.CallResult({ outcome: "success", value: sample.value, message: sample.message })
    })
}

describe("durable source checkpoint identity", () => {
  it.each(cases)(
    "keeps a partial prefix when a fresh observer receives identical call results in reverse order ($kind, $label)",
    async (sample) => {
      await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          const engine = yield* EngineStore.make({
            owner: { hostId: "source-identity" },
            journalSource: "source-identity"
          })
          const journal = yield* Journal.Journal
          const step: StepFact.Step = {
            stepId: "a".repeat(64),
            executionId: "source-identity",
            action: "agent",
            attempt: 1,
            ask: 0,
            retry: 1,
            scope: "session"
          }
          yield* engine.register(TraceFlow, () =>
            Effect.gen(function*() {
              const first = yield* EventSink.durable(journal)
              yield* first.emit(opened, step)
              yield* first.emit(observed(0, sample), step)
              const prefix = yield* facts(step.executionId)
              const prefixBytes = JSON.stringify(prefix)
              const eventType = `control.agent.cell-call-${sample.kind}`
              const original = prefix.find((row) => row.payload.eventType === eventType)!
              expect(original.payload.ordinal).toBe(1)
              // Exercise the observer contract directly. The default sandbox currently
              // serializes host calls; this is not a concurrent sandbox execution test.
              // A fresh observer replays a retained prefix with reversed arrival order.
              const replay = yield* EventSink.durable(journal)
              yield* replay.emit(opened, step)
              yield* replay.emit(observed(1, sample), step)
              yield* replay.emit(observed(0, sample), step)
              const after = yield* facts(step.executionId)
              const calls = after.filter((row) => row.payload.eventType === eventType)
              expect(calls).toHaveLength(2)
              expect(calls[0]).toEqual(original)
              expect(new Set(calls.map((row) => (row.payload.payload as { callId: string }).callId)).size).toBe(2)
              expect(new Set(calls.map((row) => row.sourceSeq)).size).toBe(2)
              expect(calls.map((row) => row.payload.ordinal)).toEqual([1, 1])
              expect(JSON.stringify(after.slice(0, prefix.length))).toBe(prefixBytes)
              for (const row of calls) {
                const payload = row.payload.payload as Record<string, unknown>
                expect(payload.callId).toEqual(expect.any(String))
                if (sample.kind === "settled") expect(payload.outcome).toBe("success")
                expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeLessThanOrEqual(262_144)
                if (sample.label !== "small result") {
                  expect(payload[sample.kind === "started" ? "input" : "value"]).toMatchObject({ truncated: true })
                }
              }
              return "done"
            }))
          const result = yield* engine.execute(TraceFlow, { executionId: step.executionId, payload: {} })
          expect(result).toBe("done")
        })).pipe(Effect.provide(stores(":memory:")), Effect.provide(NodeCrypto.layer))
      )
    },
    60_000
  )
})
