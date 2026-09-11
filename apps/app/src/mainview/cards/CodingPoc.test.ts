import { describe, expect, test } from "bun:test"
import type { Card } from "../state/AppState"
import { codingPocOf } from "./CodingPoc"
import { CODING_POC_HOST_EVENTS, CODING_POC_RESULT, codingPocJournal } from "./fixtures/CodingPoc"
import { CODING_PLAN } from "./fixtures/CodingPlan"
import { codingDecision } from "./fixtures/CodingJournal"

const card = (events: Array<Record<string, unknown>>, cursorSeq?: number): Extract<Card, { kind: "run-trace" }> => ({
  id: "workspace-poc-card", kind: "run-trace", title: "Coding", status: "active", ordinal: 1, createdAt: 0,
  payload: { repo: "smithersai/smithers", runId: "run-1", workflow: "coding", phase: "running", steps: [], result: null,
    lastSeq: events.length, events, ...(cursorSeq === undefined ? {} : { cursorSeq }) }
})
const completed = (sequence: number, id: string, parent = "request", value: unknown = CODING_POC_RESULT, generation = 0) =>
  codingDecision(sequence, id, "coding/Poc", { parent, status: "completed", generation,
    input: { plan: CODING_PLAN, source: CODING_POC_RESULT.source }, value })

describe("retained native prototype evidence", () => {
  test("real configured-host POC appears at its completion while the parent is running", () => {
    expect(codingPocOf(card(CODING_POC_HOST_EVENTS, 262))).toBeUndefined()
    const found = codingPocOf(card(CODING_POC_HOST_EVENTS, 263))
    expect(found?.executionId).toBe("a4392ed73b6ef7680ecd9a7068f3804e19d4e7de0358944469d54ebe8f4368fa")
    expect(found?.result.status).toBe("drafted-unvalidated")
    expect(found?.result.changes.files).toMatchObject([{ path: "hello.txt", before: null, after: "prototype greeting\n" }])
  })

  test("exact retained creation, replacement, deletion and BOM remain available", () => {
    expect(codingPocOf(card(codingPocJournal()))?.result).toEqual(CODING_POC_RESULT)
    expect(codingPocOf(card(codingPocJournal(), 3))).toBeUndefined()
    expect(CODING_POC_RESULT.changes.files[2]?.before?.charCodeAt(0)).toBe(0xfeff)
  })

  test("newest completed prototype replaces the summary; explicit native selection inspects an older retained result", () => {
    const newer = { ...CODING_POC_RESULT, feedback: "Second experiment" }
    const events = [...codingPocJournal(), completed(5, "poc-2", "request", newer)]
    expect(codingPocOf(card(events))?.result.feedback).toBe("Second experiment")
    expect(codingPocOf(card(events, 4))?.result.feedback).toBe(CODING_POC_RESULT.feedback)
    const selected = card(events)
    selected.payload.selection = "engine:poc:0"
    expect(codingPocOf(selected)?.result).toEqual(CODING_POC_RESULT)
  })

  test("invalid result, mismatched source, foreign parent and ambiguous generations cannot supply a prototype", () => {
    const base = codingPocJournal().slice(0, 2)
    for (const event of [
      completed(3, "poc", "request", { ...CODING_POC_RESULT, status: "validated" }),
      completed(3, "poc", "request", { ...CODING_POC_RESULT, source: { ...CODING_POC_RESULT.source, commitId: "a".repeat(40) } }),
      completed(3, "poc", "foreign"),
      completed(3, "poc", "request", { ...CODING_POC_RESULT, changes: { ...CODING_POC_RESULT.changes, files: [] } })
    ]) expect(codingPocOf(card([...base, event]))).toBeUndefined()
    expect(codingPocOf(card([...base, completed(3, "a"), completed(3, "b")]))).toBeUndefined()
    expect(codingPocOf(card([...base, codingDecision(3, "request", "coding/Request", { parent: "run-1", generation: 1 }), completed(4, "poc")]))).toBeUndefined()
    expect(codingPocOf(card([...codingPocJournal(), codingDecision(5, "poc", "coding/Poc", { parent: "request", generation: 1, status: "running" })]))).toBeUndefined()
  })

  test("a parent prose/result copy cannot claim a prototype ran", () => {
    const claimed = card([codingDecision(1, "run-1", "coding/Request", { status: "completed", value: CODING_POC_RESULT })])
    claimed.payload.result = JSON.stringify(CODING_POC_RESULT)
    expect(codingPocOf(claimed)).toBeUndefined()
  })
})
