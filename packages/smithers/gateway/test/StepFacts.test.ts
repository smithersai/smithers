import type { ControlSchema } from "@smthrs/control"
import { describe, expect, it } from "vitest"
import * as Projection from "../src/GatewayProjection.ts"
import { callEventKey, nativeStepEvent, openCallIndex, uniqueCallEvents } from "../src/internal/callEvents.ts"

const step = {
  stepId: "a".repeat(64),
  executionId: "execution",
  action: "agent",
  attempt: 1,
  ask: 0,
  retry: 1,
  scope: "left"
}
const event = (
  sequence: number,
  kind = "control.agent.cell-call-started",
  scope = step,
  generation = 0
): ControlSchema.ControlEvent => ({
  sequence,
  runId: "run",
  kind: "control.engine.event",
  occurredAt: sequence,
  payload: {
    version: 1,
    executionId: scope.executionId,
    generation,
    sequence,
    emittedAtMs: sequence,
    sourceId: `step-fact-v1:${scope.stepId}:${scope.attempt}:${scope.ask}:${scope.retry}`,
    sourceSequence: kind.endsWith("started") ? 0 : 1,
    eventType: "flows.harness.step-fact.v1",
    payload: {
      version: 1,
      step: scope,
      generation: 0,
      frame: 1,
      ordinal: 0,
      cell: "cell",
      at: 12,
      eventType: kind,
      sourceSequence: kind.endsWith("started") ? 0 : 1,
      payload: { callId: "same", flowName: "write", outcome: "success", value: scope.scope }
    }
  }
})

describe("native step facts", () => {
  it("preserves the recorded generation and time when replay republishes the prefix", () => {
    const original = event(1)
    const replay = event(2, undefined, step, 1)
    expect(nativeStepEvent(replay)).toMatchObject({
      kind: "control.agent.cell-call-started",
      payload: {
        at: 12,
        step: { ...step, generation: 0, frame: 1, ordinal: 0 }
      }
    })
    expect(uniqueCallEvents([original, replay])).toHaveLength(1)
  })
  it("rejects malformed facts and mismatched execution, source and sequence", () => {
    const valid = event(1)
    const envelope = valid.payload as Record<string, unknown>
    const payload = envelope.payload as Record<string, unknown>
    for (
      const changed of [
        null,
        {},
        { ...envelope, version: 2 },
        { ...envelope, executionId: "other" },
        { ...envelope, sourceId: "other" },
        { ...envelope, sourceSequence: 99 },
        { ...envelope, generation: -1 },
        { ...envelope, payload: { ...payload, generation: 1 } },
        { ...envelope, payload: { ...payload, payload: [] } },
        { ...envelope, payload: { ...payload, eventType: "control.run.completed" } }
      ]
    ) {
      expect(nativeStepEvent({ ...valid, payload: changed as ControlSchema.ControlEvent["payload"] })).toBeUndefined()
    }
  })
  it("keeps concurrent and repeated step calls distinct and pairs reverse settlements within their scope", () => {
    const right = { ...step, stepId: "b".repeat(64), scope: "right" }
    const retry = { ...step, attempt: 2, scope: "retry" }
    const events = [
      event(1),
      event(2, undefined, right),
      event(3, undefined, retry),
      event(4, "control.agent.cell-call-settled", retry),
      event(5, "control.agent.cell-call-settled", right),
      event(6, "control.agent.cell-call-settled")
    ]
    expect(uniqueCallEvents(events)).toHaveLength(6)
    expect(Projection.nodeOutput(events).map((row) => [row.nodeId, row.output])).toEqual([
      ["call-3", "retry"],
      ["call-2", "right"],
      ["call-1", "left"]
    ])
  })
  it("deduplicates non-call replay observations in full and incremental projections", () => {
    const first = event(1, "control.agent.turn-opened")
    const replay = event(2, "control.agent.turn-opened", step, 2)
    expect(callEventKey(first)).toBeDefined()
    expect(callEventKey(replay)).toBe(callEventKey(first))
    expect(uniqueCallEvents([first, replay])).toHaveLength(1)
    const envelope = first.payload as Record<string, unknown>
    const fact = envelope.payload as Record<string, unknown>
    const next = {
      ...first,
      payload: { ...envelope, generation: 1, payload: { ...fact, generation: 1 } }
    } as ControlSchema.ControlEvent
    expect(callEventKey(next)).not.toBe(callEventKey(first))
    expect(uniqueCallEvents([first, next])).toHaveLength(2)
  })

  it("never matches a scoped settlement to a legacy or another step's unidentified start", () => {
    const open = [{ flowName: "write", scope: "left" }, { flowName: "write" }]
    expect(openCallIndex(open, undefined, "write", "right")).toBe(-1)
    expect(openCallIndex(open, "new-id", "write", "left")).toBe(0)
    expect(openCallIndex(open, undefined, "write")).toBe(1)
  })
})
