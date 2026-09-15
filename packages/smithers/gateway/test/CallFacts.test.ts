import type { ControlSchema } from "@smthrs/control"
import { describe, expect, it } from "vitest"
import * as Projection from "../src/GatewayProjection.ts"
import { nativeCallEvent, uniqueCallEvents } from "../src/internal/callEvents.ts"

const identity = (ordinal = 0) => ({
  runId: "run",
  frame: 1,
  cell: "cell",
  ordinal,
  declaration: "declaration",
  layers: ["base"]
})
const id = (ordinal = 0) => `cell-call-v1:${String(ordinal + 1).repeat(64)}`
const event = (sequence: number, kind: string, payload: unknown): ControlSchema.ControlEvent => ({
  sequence,
  runId: "run",
  kind,
  occurredAt: sequence,
  payload: payload as ControlSchema.ControlEvent["payload"]
})
const fact = (
  sequence: number,
  phase: "invoked" | "settled",
  ordinal = 0,
  result = { outcome: "success", value: "done" }
) =>
  event(sequence, "control.engine.event", {
    version: 1,
    executionId: "native",
    generation: 0,
    sequence,
    emittedAtMs: sequence * 10,
    sourceSequence: 0,
    sourceId: `call-fact-v1:${id(ordinal)}:${phase}`,
    eventType: "flows.harness.call-fact.v1",
    payload: {
      version: 1,
      phase,
      callId: id(ordinal),
      identity: identity(ordinal),
      flowName: "write",
      ...(phase === "invoked" ? { input: { path: ordinal } } : result)
    }
  })

describe("native call fact projections", () => {
  it("prefers committed facts over identified telemetry, preserves display IDs, and pairs reverse settlements exactly", () => {
    const events = [
      event(1, "control.agent.cell-call-started", { callId: id(), flowName: "write", input: { path: 0 } }),
      event(2, "control.agent.cell-call-started", { callId: id(1), flowName: "write", input: { path: 1 } }),
      event(3, "control.agent.cell-call-settled", {
        callId: id(1),
        flowName: "write",
        outcome: "success",
        value: "unconfirmed"
      }),
      fact(4, "invoked"),
      fact(5, "invoked", 1),
      fact(6, "settled", 1, { outcome: "failure", value: "timeout" }),
      fact(7, "settled"),
      fact(8, "invoked"),
      fact(9, "settled"),
      event(10, "control.agent.cell-call-settled", {
        callId: id(),
        flowName: "write",
        outcome: "failure",
        message: "late telemetry"
      })
    ]
    const run = { runId: "run", flowId: "agent", status: "completed" as const, createdAt: 1, updatedAt: 10 }
    expect(Projection.runTree(run, events).map((row) => [row.nodeId, row.status, row.startedAt])).toEqual([
      ["call-1", "completed", 40],
      ["call-2", "failed", 50]
    ])
    expect(Projection.nodeOutput(events).map((row) => [row.nodeId, row.outcome])).toEqual([["call-2", "failure"], [
      "call-1",
      "success"
    ]])
    const transcript = Projection.transcript(events)
    expect(transcript).toHaveLength(4)
    expect(transcript.map((row) => row.sequence)).toEqual([1, 2, 3, 7])
    expect(transcript[2]?.text).toContain("FAIL")
    expect(uniqueCallEvents(events).filter((entry) => entry.kind === "control.agent.cell-call-started")).toHaveLength(2)
  })

  it("refuses foreign, malformed and unsupported native facts without inventing an identity for legacy history", () => {
    const valid = fact(1, "invoked")
    expect(nativeCallEvent(valid)?.kind).toBe("control.agent.cell-call-started")
    const envelope = valid.payload as Record<string, unknown>
    for (
      const changed of [
        null,
        {},
        { ...envelope, version: 2 },
        { ...envelope, sourceSequence: 1 },
        { ...envelope, sourceId: "foreign" },
        { ...envelope, payload: {} },
        { ...envelope, eventType: "unknown" },
        { ...envelope, payload: { ...(envelope.payload as object), input: undefined } }
      ]
    ) {
      expect(nativeCallEvent({ ...valid, payload: changed as ControlSchema.ControlEvent["payload"] })).toBeUndefined()
    }
    expect(nativeCallEvent({ ...valid, runId: "foreign" })).toBeUndefined()
    expect(nativeCallEvent(event(2, "other", {}))).toBeUndefined()
    const old = event(3, "control.agent.cell-call-started", { flowName: "write" })
    expect(uniqueCallEvents([old, old])).toEqual([old, old])
  })
})
