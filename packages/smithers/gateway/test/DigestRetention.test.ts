import { describe, expect, it } from "@effect/vitest"
import type { Service as ControlService } from "@smthrs/control/Control"
import type { ControlEvent, RunSummary } from "@smthrs/control/ControlSchema"
import { Effect, Stream } from "effect"
import * as Diagnosis from "../src/Diagnosis.ts"
import * as Projections from "../src/Projections.ts"
import { moduleRunJournal } from "./fixtures/module-run-journal.ts"

const callId = `cell-call-v1:${"a".repeat(64)}`
const event = (sequence: number, kind: string, payload: ControlEvent["payload"]): ControlEvent => ({
  sequence,
  kind,
  payload,
  runId: "run",
  occurredAt: sequence
})
const telemetry = event(0, "control.agent.cell-call-settled", {
  callId,
  flowName: "write",
  outcome: "failure",
  message: "unconfirmed"
})
const committed = (sequence: number): ControlEvent =>
  event(sequence, "control.engine.event", {
    version: 1,
    executionId: "native",
    generation: 0,
    sequence,
    emittedAtMs: 10,
    sourceSequence: 0,
    sourceId: `call-fact-v1:${callId}:settled`,
    eventType: "flows.harness.call-fact.v1",
    payload: {
      version: 1,
      phase: "settled",
      callId,
      identity: { runId: "run", frame: 1, cell: "cell", ordinal: 0, declaration: "declaration", layers: [] },
      flowName: "write",
      outcome: "success",
      value: "done"
    }
  })
const legacyStepCall = (sequence: number): ControlEvent =>
  event(sequence, "control.engine.event", {
    version: 1,
    executionId: "native",
    generation: 0,
    sequence,
    emittedAtMs: 10,
    sourceSequence: 0,
    sourceId: `step-fact-v1:${"b".repeat(64)}:1:0:1`,
    eventType: "flows.harness.step-fact.v1",
    payload: {
      version: 1,
      step: {
        stepId: "b".repeat(64),
        executionId: "native",
        action: "agent",
        attempt: 1,
        ask: 0,
        retry: 1,
        scope: "left"
      },
      generation: 0,
      frame: 1,
      ordinal: 0,
      cell: "call",
      at: 10,
      eventType: "control.agent.cell-call-started",
      sourceSequence: 0,
      payload: { flowName: "write" }
    }
  })
const run: RunSummary = { runId: "run", flowId: "fixture", status: "completed", createdAt: 0, updatedAt: 20 }
const control = (events: ReadonlyArray<ControlEvent>): ControlService =>
  ({
    list: () => Effect.succeed({ _tag: "runs", items: [run] }),
    watch: () => Stream.fromIterable(events)
  }) as unknown as ControlService

describe("diagnosis retention", () => {
  it("reconciles duplicate calls and native upgrades across every digest boundary", () => {
    const history = [
      event(0, "control.agent.turn-opened", { seat: "first" }),
      telemetry,
      event(1, "control.agent.cell-call-started", { callId, flowName: "write" }),
      committed(2),
      event(3, "control.agent.turn-opened", { seat: "last" }),
      committed(4),
      event(5, "control.agent.cell-call-started", { callId, flowName: "write" }),
      event(6, "control.agent.resolved", { text: "done" })
    ]
    const whole = Diagnosis.digest(history)
    for (let split = 0; split <= history.length; split++) {
      expect(Diagnosis.combine(Diagnosis.digest(history.slice(0, split)), Diagnosis.digest(history.slice(split))))
        .toEqual(whole)
    }
    const incremental = history.reduce(
      (carry, member) => Diagnosis.combine(carry, Diagnosis.digest([member])),
      Diagnosis.emptyDigest()
    )
    expect(incremental).toEqual(whole)
  })

  it("deduplicates replayed step turns and tokens across carried windows", () => {
    const repeated = moduleRunJournal.map((member) => ({ ...member, sequence: member.sequence + 1000 }))
    expect(Diagnosis.combine(Diagnosis.digest(moduleRunJournal), Diagnosis.digest(repeated)))
      .toEqual(Diagnosis.digest([...moduleRunJournal, ...repeated]))
  })

  it("deduplicates a checkpoint replay even when the older call has no call ID", () => {
    const first = legacyStepCall(0)
    const replay = legacyStepCall(1)
    const whole = Diagnosis.digest([first, replay])
    expect(whole.calls).toBe(1)
    expect(Diagnosis.combine(Diagnosis.digest([first]), Diagnosis.digest([replay]))).toEqual(whole)
  })

  it("preserves cleared root fields and refusal tie order across boundaries", () => {
    const history = [
      event(0, "control.run.failed", { cause: "old cause" }),
      event(1, "control.agent.resolved", { text: "old output" }),
      event(2, "control.approval.requested", { question: "old question" }),
      event(3, "control.agent.cell-call-settled", { outcome: "failure", message: "first" }),
      event(4, "control.agent.cell-call-settled", { outcome: "failure", message: "second" }),
      event(5, "control.agent.cell-call-settled", { outcome: "failure", message: "second" }),
      event(6, "control.run.failed", {}),
      event(7, "control.agent.resolved", {}),
      event(8, "control.approval.requested", {}),
      event(9, "control.agent.cell-call-settled", { outcome: "failure", message: "first" })
    ]
    for (let split = 0; split <= history.length; split++) {
      expect(Diagnosis.combine(Diagnosis.digest(history.slice(0, split)), Diagnosis.digest(history.slice(split))))
        .toEqual(Diagnosis.digest(history))
    }
  })

  it("keeps prior digest objects valid when a later native fact supersedes telemetry", () => {
    const original = Diagnosis.digest([telemetry])
    const updated = Diagnosis.combine(original, Diagnosis.digest([committed(1)]))
    expect(updated.callsFailed).toBe(0)
    expect(original.callsFailed).toBe(1)
    expect(Diagnosis.combine(original, Diagnosis.emptyDigest())).toEqual(original)
    expect(Diagnosis.combine(updated, Diagnosis.digest([telemetry]))).toEqual(updated)
  })

  it("corrects a call's contribution within an existing run span", () => {
    const history = [
      event(0, "control.agent.turn-opened", { at: 0 }),
      event(1, "control.agent.turn-opened", { at: 100 }),
      event(2, "control.agent.cell-call-settled", { callId, flowName: "read", outcome: "success", at: 50 }),
      committed(3)
    ]
    const whole = Diagnosis.digest(history)
    expect(whole).toMatchObject({ editsSucceeded: 1, startedAt: 0, endedAt: 100 })
    expect(history.reduce(
      (carry, member) => Diagnosis.combine(carry, Diagnosis.digest([member])),
      Diagnosis.emptyDigest()
    )).toEqual(whole)
  })

  it.effect("upgrades an evicted telemetry refusal without adding a second settlement", () =>
    Effect.gen(function*() {
      const history = [
        telemetry,
        ...Array.from({ length: Projections.maxEventsPerRun }, (_, index) => event(index + 1, "noop", null)),
        committed(Projections.maxEventsPerRun + 1)
      ]
      const projections = yield* Projections.make(control(history))
      const snapshot = yield* projections.snapshot({ _tag: "run-summary", runId: "run" })
      expect(snapshot.rows[0]).toMatchObject({ callsFailed: 0, editsSucceeded: 1 })
      expect(snapshot.rows[0]?.diagnosis).not.toContain("unconfirmed")
    }))

  it.effect("refuses identity state that cannot fit the retained byte budget", () =>
    Effect.gen(function*() {
      const history = Array.from({ length: 3000 }, (_, index) =>
        event(index, "control.agent.cell-call-started", {
          callId: `${index}:${"x".repeat(1500)}`,
          flowName: "write"
        }))
      const projections = yield* Projections.make(control(history))
      const failure = yield* Effect.flip(projections.snapshot({ _tag: "run-summary", runId: "run" }))
      expect(failure).toMatchObject({ code: "resource_limit" })
    }))
})
