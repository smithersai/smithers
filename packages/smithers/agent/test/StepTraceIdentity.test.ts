import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import { Flow } from "@smthrs/flow"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import { Journal, type StepFact } from "@smthrs/journal"
import { Node } from "@smthrs/plan"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as EventSink from "../src/EventSink.ts"
import { facts, stores } from "./fixtures/step-trace-stack.ts"

const TraceFlow = Flow.make("test/trace-source-identity", {
  payload: {},
  success: Schema.String,
  body: () => Node.succeed("done")
})
const opened = new AgentEvent.TurnOpened({
  eventType: "flows.harness.turn-opened.v1",
  seat: "test",
  modelParams: {},
  activeToolNames: [],
  contextDigest: "context"
})
const settled = (ordinal: number) =>
  new AgentEvent.CellCallSettled({
    eventType: "flows.harness.cell-call-settled.v1",
    flowName: "read",
    identity: new Cell.CallIdentity({
      session: "session",
      frame: 0,
      cell: "cell",
      ordinal,
      declaration: "read",
      layers: []
    }),
    result: new Cell.CallResult({ outcome: "success", value: "same" })
  })

describe("durable source checkpoint identity", () => {
  it("keeps a partial prefix when a fresh observer receives identical call results in reverse order", async () => {
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
            yield* first.emit(settled(0), step)
            const prefix = yield* facts(step.executionId)
            const original = prefix.find((row) => row.payload.eventType === "control.agent.cell-call-settled")!
            expect(original.payload.ordinal).toBe(1)
            // Exercise the observer contract directly. The default sandbox currently
            // serializes host calls; this is not a concurrent sandbox execution test.
            // A fresh observer replays a retained prefix with reversed arrival order.
            const replay = yield* EventSink.durable(journal)
            yield* replay.emit(opened, step)
            yield* replay.emit(settled(1), step)
            yield* replay.emit(settled(0), step)
            const after = yield* facts(step.executionId)
            const calls = after.filter((row) => row.payload.eventType === "control.agent.cell-call-settled")
            expect(calls).toHaveLength(2)
            expect(calls[0]).toEqual(original)
            expect(new Set(calls.map((row) => (row.payload.payload as { callId: string }).callId)).size).toBe(2)
            expect(new Set(calls.map((row) => row.sourceSeq)).size).toBe(2)
            expect(calls.map((row) => row.payload.ordinal)).toEqual([1, 1])
            expect(after.slice(0, prefix.length)).toEqual(prefix)
            return "done"
          }))
        const result = yield* engine.execute(TraceFlow, { executionId: step.executionId, payload: {} })
        expect(result).toBe("done")
      })).pipe(Effect.provide(stores(":memory:")), Effect.provide(NodeCrypto.layer))
    )
  }, 60_000)
})
