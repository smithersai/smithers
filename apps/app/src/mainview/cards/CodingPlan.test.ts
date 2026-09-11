import { describe, expect, test } from "bun:test"
import type { Card } from "../state/AppState"
import { codingEvidenceOf, codingPlanOf } from "./CodingPlan"
import { CODING_PLAN } from "./fixtures/CodingPlan"
import { blockedCodingJournal, blockedCorrection, codingDecision, earlyCodingJournal, preparedCodingJournal } from "./fixtures/CodingJournal"

const card = (events: Array<Record<string, unknown>>, cursorSeq?: number): Extract<Card, { kind: "run-trace" }> => ({
  id: "workspace-run-card", kind: "run-trace", title: "Coding", status: "active", ordinal: 1, createdAt: 0,
  payload: { repo: "smithersai/smithers", runId: "run-1", workflow: "coding", phase: "running", steps: [], result: null,
    lastSeq: events.length, input: { prompt: CODING_PLAN.prompt }, events, ...(cursorSeq === undefined ? {} : { cursorSeq }) }
})
const next = { ...CODING_PLAN, memoryRevision: "new-memory", changes: [{ ...CODING_PLAN.changes[0]!, id: "replanned", title: "Replanned storage" }] }

describe("coding product facts from recorded native executions", () => {
  test("the real configured-host journal projects its plan and validated outcome across normal ownership decisions", async () => {
    // Captured from the scripted native-JJ/SQLite coding request acceptance
    // (2026-09-09). These are the unmodified records for the five relevant
    // executions; attempt events and unrelated child executions are omitted.
    const source = await Bun.file(new URL("./fixtures/CodingHostDecisions.ndjson", import.meta.url)).text()
    const events = source.trim().split("\n").map((line) => JSON.parse(line))
    const prepared = events.find((row) => row.payload.payload.state?.flowName === "coding/PreparePlan" && row.payload.payload.status === "completed")
    const planned = prepared.payload.payload.state.result.exit.value
    const correcting = events.find((row) => row.payload.payload.state?.flowName === "coding/CorrectPlan" && row.payload.payload.decision === "created")
    expect(codingPlanOf(card(events, prepared.sequence - 1))).toBeUndefined()
    expect(codingEvidenceOf(card(events, correcting.sequence))).toEqual({ plan: planned })
    expect(codingEvidenceOf(card(events)).outcome?.status).toBe("validated")
    expect(codingEvidenceOf(card(events)).plan).toEqual(planned)
  })

  test("the validated child plan appears while implementation is still running, never before its historical completion", () => {
    const events = preparedCodingJournal()
    expect(codingPlanOf(card(events))).toEqual(CODING_PLAN)
    expect(codingEvidenceOf(card(events)).outcome).toBeUndefined()
    expect(codingPlanOf(card(events, 3))).toBeUndefined()
    expect(codingPlanOf(card(events, 4))).toEqual(CODING_PLAN)
    expect(codingPlanOf(card([...events].reverse()))).toEqual(CODING_PLAN)
  })

  test("a completed replan replaces the older plan, and invalid plans or model prose are never promoted", () => {
    const events = [...preparedCodingJournal(),
      codingDecision(6, "replan", "coding/PrepareWithWiki", { parent: "request", status: "completed", value: next })]
    expect(codingPlanOf(card(events))).toEqual(next)
    expect(codingPlanOf(card(events, 5))).toEqual(CODING_PLAN)
    const invalid = { ...next, changes: [next.changes[0], next.changes[0]] }
    expect(codingPlanOf(card([...events, codingDecision(7, "invalid", "coding/PreparePlan", { parent: "request", status: "completed", value: invalid })]))).toEqual(next)
    expect(codingPlanOf(card([{ sequence: 1, kind: "control.agent.resolved", payload: { output: JSON.stringify(CODING_PLAN) } }]))).toBeUndefined()
  })

  test("rewound executions never borrow an older generation's completed output", () => {
    const events = [...preparedCodingJournal(), codingDecision(6, "prepare", "coding/PreparePlan", { parent: "request", status: "running", generation: 1 })]
    expect(codingPlanOf(card(events))).toBeUndefined()
    expect(codingPlanOf(card(events, 5))).toEqual(CODING_PLAN)
    expect(codingPlanOf(card([...events, codingDecision(7, "prepare", "coding/PreparePlan", { parent: "request", status: "completed", generation: 1, value: next })]))).toEqual(next)
    expect(codingPlanOf(card([...preparedCodingJournal(), codingDecision(6, "request", "coding/Request", { parent: "run-1", status: "running", generation: 1 })]))).toBeUndefined()
  })

  test("v2 trampoline lineage never replaces the recorded native spawn parent", () => {
    const terminal = codingDecision(4, "prepare", "coding/PreparePlan", { parent: "request", status: "completed", value: CODING_PLAN })
    const state = { ...terminal, payload: { ...terminal.payload, eventType: "flows.engine.v2.state-event", payload: {
      version: 2, executionId: "prepare", lineage: {
        kind: "root", runId: "prepare", rootRunId: "prepare", lineageId: "prepare", round: 0, parentRunId: null
      }, event: { _tag: "Execution", lifecycle: { state: "completed", result: { _tag: "Success", value: CODING_PLAN } } }
    } } }
    expect(codingPlanOf(card([...preparedCodingJournal().slice(0, 3), state]))).toEqual(CODING_PLAN)
    // A v2 record with no decoded RunState cannot invent a spawn edge, even
    // when its lineage happens to name this card's native execution.
    const lineageOnly = { ...state, payload: { ...state.payload, payload: { ...state.payload.payload,
      lineage: { ...state.payload.payload.lineage, parentRunId: "run-1" }
    } } }
    expect(codingPlanOf(card([preparedCodingJournal()[0]!, lineageOnly]))).toBeUndefined()
  })

  test("foreign, cyclic, conflicting and ambiguous native evidence cannot supply a plan", () => {
    const root = codingDecision(1, "run-1", "agent/run")
    const completed = (sequence: number, id: string, parent?: string) => codingDecision(sequence, id, "coding/PreparePlan", { parent, status: "completed", value: CODING_PLAN })
    expect(codingPlanOf(card([root, completed(2, "orphan")]))).toBeUndefined()
    expect(codingPlanOf(card([root, completed(2, "foreign", "another-run")]))).toBeUndefined()
    expect(codingPlanOf(card([root, completed(2, "cycle-a", "cycle-b"), completed(3, "cycle-b", "cycle-a")]))).toBeUndefined()
    expect(codingPlanOf(card([root, completed(2, "same", "run-1"), completed(3, "same", "foreign")]))).toBeUndefined()
    expect(codingPlanOf(card([root, completed(2, "a", "run-1"), completed(2, "b", "run-1")]))).toBeUndefined()
    const duplicate = preparedCodingJournal()
    expect(codingPlanOf(card([...duplicate, { ...duplicate[3]!, payload: { ...duplicate[3]!.payload, eventId: "conflicting-duplicate" } }]))).toBeUndefined()
    expect(codingPlanOf(card([{ ...root, payload: { ...root.payload, version: 99 } }, completed(2, "missing-root", "run-1")]))).toBeUndefined()
    const malformed = { ...root, payload: { ...root.payload, payload: { decision: "created" } } }
    expect(codingPlanOf(card([malformed, completed(2, "missing-state", "run-1")]))).toBeUndefined()
    const malformedAfter = { ...root, sequence: 6, payload: { ...root.payload, sequence: 6, eventId: "malformed-after",
      payload: { decision: "transitioned", status: "completed" } } }
    expect(codingPlanOf(card([...preparedCodingJournal(), malformedAfter]))).toBeUndefined()
  })

  test("blocked is a domain outcome, with navigation only to its recorded failed descendant", () => {
    const events = blockedCodingJournal()
    const value = codingEvidenceOf(card(events))
    expect(value.plan).toEqual(CODING_PLAN)
    expect(value.outcome).toEqual(blockedCorrection)
    expect(value.blockedSpanId).toBe("engine:failed-round:0")
    expect(codingEvidenceOf(card(events, 7)).outcome).toBeUndefined()
    expect(codingEvidenceOf(card(events, 8)).outcome?.status).toBe("blocked")
    const unrelated = events.map(row => row.payload.executionId === "failed-round"
      ? codingDecision(row.sequence, "failed-round", "coding/ImplementPlan", { parent: "run-1", status: row.sequence === 7 ? "failed" : "running" }) : row)
    expect(codingEvidenceOf(card(unrelated)).outcome?.status).toBe("blocked")
    expect(codingEvidenceOf(card(unrelated)).blockedSpanId).toBeUndefined()
  })

  test("completion alone, contradictory outcomes and a result for another plan cannot claim validation", () => {
    const events = preparedCodingJournal()
    const validated = { status: "validated", rounds: 1, result: { status: "validated", changes: [], findings: [] }, blocked: null }
    const finish = (value: unknown, plan = CODING_PLAN) => codingDecision(6, "correct", "coding/CorrectPlan", {
      parent: "request", status: "completed", input: { plan, maxRounds: 2 }, value
    })
    expect(codingEvidenceOf(card([...events, finish(validated)])).outcome?.status).toBe("validated")
    expect(codingEvidenceOf(card([...events, finish({ ...validated, blocked: blockedCorrection.blocked })])).outcome).toBeUndefined()
    expect(codingEvidenceOf(card([...events, finish({ ...validated, result: null })])).outcome).toBeUndefined()
    expect(codingEvidenceOf(card([...events, finish(validated, next)])).outcome).toBeUndefined()
    expect(codingEvidenceOf(card([...events, finish({ message: "all done" })])).outcome).toBeUndefined()
    const completed = card(events)
    completed.payload.phase = "completed"
    expect(codingEvidenceOf(completed).outcome).toBeUndefined()
    // Replanning even the same bytes must not inherit an older validation.
    expect(codingEvidenceOf(card([...events, finish(validated), codingDecision(7, "new-plan", "coding/PreparePlan", { parent: "request", status: "completed", value: CODING_PLAN })])).outcome).toBeUndefined()
  })

  test("legacy manual plans remain inspectable before any journal and at historical cursors", () => {
    const manual = card([], 0)
    manual.payload.input = { plan: CODING_PLAN }
    expect(codingPlanOf(manual)).toEqual(CODING_PLAN)
    manual.payload.input = { plan: { ...CODING_PLAN, changes: [] } }
    expect(codingPlanOf(manual)).toBeUndefined()
  })

  test("typed early feedback can stop a child while its parent repairs and later validates", () => {
    const early = JSON.parse(JSON.stringify(codingDecision(6, "observe", "coding/ObservePlan", {
      parent: "correct", status: "failed"
    })))
    early.payload.payload.state.result.exit.cause = [{ _tag: "Fail", error: {
      _tag: "coding/EarlyFeedback", result: { status: "changes-requested", changes: [], findings: [] }
    } }]
    const events = [...preparedCodingJournal(), early]
    expect(codingEvidenceOf(card(events))).toEqual({ plan: CODING_PLAN })
    const outcome = { status: "validated", rounds: 2, result: { status: "validated", changes: [], findings: [] }, blocked: null } as const
    const repaired = [...events, codingDecision(7, "correct", "coding/CorrectPlan", {
      parent: "request", status: "completed", input: { plan: CODING_PLAN, maxRounds: 2 }, value: outcome
    })]
    expect(codingEvidenceOf(card(repaired))).toEqual({ plan: CODING_PLAN, outcome })
  })

  test("actionable native early feedback stays separate from validation and is superseded by correction", () => {
    const events = earlyCodingJournal()
    const visible = codingEvidenceOf(card(events))
    expect(visible.reviewFeedback?.result.findings[0]?.message).toBe("Keep the causal revision when merging wiki edits.")
    expect(visible.reviewFeedback?.spanId).toBe("engine:observe:0")
    expect(visible.outcome).toBeUndefined()
    expect(codingEvidenceOf(card(events, 5)).reviewFeedback).toBeUndefined()
    const outcome = { status: "validated", rounds: 2, result: { status: "validated", changes: [], findings: [] }, blocked: null } as const
    expect(codingEvidenceOf(card([...events, codingDecision(7, "correct", "coding/CorrectPlan", {
      parent: "request", status: "completed", input: { plan: CODING_PLAN, maxRounds: 2 }, value: outcome
    })]))).toEqual({ plan: CODING_PLAN, outcome })
  })

  test("early feedback needs the exact plan, active correction owner and unambiguous typed failure", () => {
    const original = earlyCodingJournal()
    for (const fault of ["foreign-owner", "different-plan", "generic-error", "mixed-defect", "no-findings", "partial-implementation"] as const) {
      const events = JSON.parse(JSON.stringify(original))
      const state = events.at(-1).payload.payload.state
      const error = state.result.exit.cause[0].error
      if (fault === "foreign-owner") state.parentExecutionId = "run-1"
      if (fault === "different-plan") state.payload.plan = next
      if (fault === "generic-error") error._tag = "coding/Error"
      if (fault === "mixed-defect") state.result.exit.cause.push({ _tag: "Die", defect: "real bug" })
      if (fault === "no-findings") error.result.findings = []
      if (fault === "partial-implementation") error.result.changes.pop()
      expect(codingEvidenceOf(card(events)).reviewFeedback).toBeUndefined()
    }
    expect(codingEvidenceOf(card([...original, codingDecision(7, "correct", "coding/CorrectPlan", {
      parent: "request", status: "failed", input: { plan: CODING_PLAN }
    })])).reviewFeedback).toBeUndefined()
    expect(codingEvidenceOf(card([...original, codingDecision(7, "observe", "coding/ObservePlan", {
      parent: "correct", status: "running", input: { plan: CODING_PLAN }, generation: 1
    })])).reviewFeedback).toBeUndefined()
    expect(codingEvidenceOf(card([...original, codingDecision(7, "new-plan", "coding/PreparePlan", {
      parent: "request", status: "completed", value: CODING_PLAN
    })])).reviewFeedback).toBeUndefined()
  })

  test("classified v2 failures use their typed payload and keep recorded native ancestry", () => {
    const events = earlyCodingJournal()
    const last = JSON.parse(JSON.stringify(events.at(-1)))
    const error = last.payload.payload.state.result.exit.cause[0].error
    const v2 = { ...last, sequence: 7, payload: { ...last.payload, sequence: 7, eventId: "v2-failure", eventType: "flows.engine.v2.state-event",
      payload: { version: 2, executionId: "observe", lineage: { kind: "root", runId: "observe", rootRunId: "observe", lineageId: "observe", round: 0, parentRunId: null },
        event: { _tag: "Execution", lifecycle: { state: "completed", result: { _tag: "Failure", reason: "error", detail: error } } } } } }
    expect(codingEvidenceOf(card([...events, v2])).reviewFeedback?.spanId).toBe("engine:observe:0")
    v2.payload.payload.event.lifecycle.result.reason = "defect"
    expect(codingEvidenceOf(card([...events, v2])).reviewFeedback).toBeUndefined()
  })
})
