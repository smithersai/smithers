import { describe, expect, test } from "bun:test"
import { codingVibeAvailable, codingVibeRequestOf, codingVibeProgressOf } from "./CodingVibe"
import { CODING_REQUEST_ID, completedRequestCard, vibeCatalog, VIBE_ADMISSION } from "./fixtures/CodingVibe"
import { codingDecision } from "./fixtures/CodingJournal"

describe("the Vibe invitation is derived from retained native request evidence", () => {
  test("actual completed native request and bridge yield only its execution address", () => {
    const card = completedRequestCard()
    expect(codingVibeRequestOf(card)).toEqual({ requestExecutionId: CODING_REQUEST_ID, spanId: `engine:${CODING_REQUEST_ID}:0` })
    expect(codingVibeRequestOf({ ...card, payload: { ...card.payload, cursorSeq: 328 } })).toBeUndefined()
    expect(codingVibeRequestOf({ ...card, payload: { ...card.payload, phase: "running" } })).toBeUndefined()
    expect(codingVibeRequestOf({ ...card, payload: { ...card.payload, workflow: "other/flow" } })).toBeUndefined()
  })

  test("green parents, prose, missing ancestry, ambiguity and restarted generations cannot invite finalization", () => {
    const card = completedRequestCard()
    const rewrite = (change: (state: Record<string, unknown>, row: Record<string, unknown>) => void) => {
      const events = structuredClone(card.payload.events!)
      for (const event of events) {
        const envelope = event.payload as Record<string, unknown>
        const body = envelope.payload as Record<string, unknown>
        const state = body.state as Record<string, unknown> | undefined
        if (state !== undefined) change(state, envelope)
      }
      return { ...card, payload: { ...card.payload, events } }
    }
    expect(codingVibeRequestOf({ ...card, payload: { ...card.payload, events: [], result: JSON.stringify({ status: "validated" }) } })).toBeUndefined()
    expect(codingVibeRequestOf(rewrite(state => { if (state.flowName === "coding/request") state.flowName = "coding/RunRequest" }))).toBeUndefined()
    expect(codingVibeRequestOf(rewrite(state => { if (state.flowName === "coding/request") state.payload = { input: { prompt: "other" } } }))).toBeUndefined()
    expect(codingVibeRequestOf(rewrite(state => { if (state.flowName === "agent/run") state.payload = {} }))).toBeUndefined()
    expect(codingVibeRequestOf(rewrite(state => { if (state.flowName === "coding/Request") state.parentExecutionId = "foreign-root" }))).toBeUndefined()
    const restarted = codingDecision(330, CODING_REQUEST_ID, "coding/Request", { generation: 1, status: "running", parent: "run-1" })
    expect(codingVibeRequestOf({ ...card, payload: { ...card.payload, events: [...card.payload.events!, restarted] } })).toBeUndefined()
  })

  test("only a source-qualified full-flow catalog makes the invitation available", () => {
    const card = completedRequestCard(), catalog = vibeCatalog()
    expect(codingVibeAvailable(card, [catalog])).toBe(true)
    for (const payload of [
      { ...catalog.payload, gatewayBindingVersion: undefined },
      { ...catalog.payload, repo: "other/repo" },
      { ...catalog.payload, workspaceId: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
      { ...catalog.payload, workflows: [{ key: "coding/AdmitVibe", description: null }] },
      { ...catalog.payload, workflows: [] }
    ]) expect(codingVibeAvailable(card, [{ ...catalog, payload }])).toBe(false)
    expect(codingVibeAvailable(card, [catalog, { ...catalog, id: "newer", ordinal: 3, payload: { ...catalog.payload, workflows: [] } }])).toBe(false)
    expect(codingVibeAvailable(card, [catalog, { ...catalog, id: "ambiguous" }])).toBe(false)
  })
})


test("finalization projects source-qualified child receipts and never infers landing from a green parent", () => {
  const input = { requestExecutionId: CODING_REQUEST_ID }
  const admitted = codingDecision(4, "admission", "coding/AdmitVibe", { parent: "vibe", status: "completed", input, value: VIBE_ADMISSION })
  const cleanup = { admission: VIBE_ADMISSION, summary: "Describe the validated greeting.", result: VIBE_ADMISSION.request.outcome.result!, head: VIBE_ADMISSION.validatedHead }
  const events = [
    codingDecision(1, "vibe-root", "agent/run", { status: "running", input: { planId: "vibe-plan" } }),
    codingDecision(2, "vibe-bridge", "coding/vibe", { parent: "vibe-root", status: "running", input: { input } }),
    codingDecision(3, "vibe", "coding/Vibe", { parent: "vibe-bridge", status: "running", input }), admitted,
    codingDecision(5, "cleanup", "coding/CleanVibeHistory", { parent: "vibe", status: "completed", value: cleanup })
  ]
  const original = completedRequestCard()
  const card = { ...original, payload: { ...original.payload, workflow: "coding/vibe", runId: "vibe-root", input, events } }
  expect(codingVibeProgressOf(card)).toMatchObject({ stage: "cleaned", spanId: "engine:cleanup:0", summary: cleanup.summary })
  expect(codingVibeProgressOf({ ...card, payload: { ...card.payload, cursorSeq: 4 } })).toMatchObject({ stage: "admitted", spanId: "engine:admission:0" })
  expect(codingVibeProgressOf({ ...card, payload: { ...card.payload, cursorSeq: 3 } })).toBeUndefined()
  expect(codingVibeProgressOf({ ...card, payload: { ...card.payload, input: { requestExecutionId: "foreign" } } })).toBeUndefined()
  expect(codingVibeProgressOf({ ...card, payload: { ...card.payload, events: events.slice(0, 3).concat([
    codingDecision(6, "vibe", "coding/Vibe", { parent: "vibe-bridge", status: "completed", value: cleanup })
  ]) } })).toBeUndefined()
  expect(codingVibeProgressOf({ ...card, payload: { ...card.payload, events: events.slice(0, 3).concat([
    codingDecision(4, "admission", "coding/AdmitVibe", { parent: "foreign", status: "completed", input, value: VIBE_ADMISSION })
  ]) } })).toBeUndefined()
})
