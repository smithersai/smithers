import { describe, expect, test } from "bun:test"
import { codingVibeAvailable, codingVibeRequestOf, codingVibeProgressOf } from "./CodingVibe"
import { CODING_REQUEST_ID, completedRequestCard, vibeCatalog, VIBE_ADMISSION, publicationVibeCard } from "./fixtures/CodingVibe"
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


test("original retention renders before admission completes and cleaned retention follows the exact cleanup receipt", () => {
  const card = publicationVibeCard()
  expect(codingVibeProgressOf(card)).toMatchObject({ stage: "cleaned-retained", spanId: "engine:cleaned-publication:0",
    sourceCommitId: VIBE_ADMISSION.validatedHead.commitId, requestExecutionId: CODING_REQUEST_ID })
  expect(codingVibeProgressOf({ ...card, payload: { ...card.payload, cursorSeq: 7 } })).toMatchObject({ stage: "cleaned" })
  expect(codingVibeProgressOf({ ...card, payload: { ...card.payload, cursorSeq: 6 } })).toMatchObject({ stage: "admitted" })
  expect(codingVibeProgressOf({ ...card, payload: { ...card.payload, cursorSeq: 5 } })).toMatchObject({
    stage: "original-retained", spanId: "engine:original-publication:0",
    sourceCommitId: VIBE_ADMISSION.originalSource.commitId, requestExecutionId: CODING_REQUEST_ID })
  expect(codingVibeProgressOf({ ...card, payload: { ...card.payload, cursorSeq: 5 } })?.requestControlRunId).toBeUndefined()
  expect(codingVibeProgressOf({ ...card, payload: { ...card.payload, cursorSeq: 4 } })).toBeUndefined()
})

test("retention refuses foreign ownership, workspace, source, phase, ref, generations and unavailable cleanup", () => {
  const card = publicationVibeCard()
  type MutableState = { parentExecutionId?: string,
    payload: { source: { treeId: string }; phase: string; requestExecutionId: string; input: { requestExecutionId: string } },
    result: { exit: { value: { workspaceId: string; ref: string; source: { parentCommitIds: string[] } } } } }
  const mutate = (executionId: string, change: (state: MutableState) => void) => {
    const events = structuredClone(card.payload.events!).filter(event => Number(event.sequence) <= 5)
    for (const event of events) {
      const envelope = event.payload as { executionId: string; payload: { state: MutableState } }
      if (envelope.executionId === executionId) change(envelope.payload.state)
    }
    return { ...card, payload: { ...card.payload, events } }
  }
  const bad = [
    mutate("original-publication", state => { state.parentExecutionId = "foreign" }),
    mutate("original-publication", state => { state.payload.source.treeId = "a".repeat(40) }),
    mutate("original-publication", state => { state.payload.phase = "cleaned" }),
    mutate("original-publication", state => { state.result.exit.value.workspaceId = "ffffffff-ffff-ffff-ffff-ffffffffffff" }),
    mutate("original-publication", state => { state.result.exit.value.ref = "refs/heads/main" }),
    mutate("original-publication", state => { state.result.exit.value.source.parentCommitIds = [] }),
    mutate("admission", state => { state.payload.requestExecutionId = "foreign" }),
    mutate("vibe-bridge", state => { state.payload.input.requestExecutionId = "foreign" })
  ]
  for (const invalid of bad) expect(codingVibeProgressOf(invalid)).toBeUndefined()
  const restarted = mutate("original-publication", () => {})
  expect(codingVibeProgressOf({ ...restarted, payload: { ...restarted.payload, events: [...restarted.payload.events!,
    codingDecision(9, "original-publication", "coding/PublishVibeSource", { generation: 1, parent: "admission", status: "running" })] } })).toBeUndefined()
  const withoutCleanup = { ...card, payload: { ...card.payload, events: card.payload.events!.filter(event => event.sequence !== 7) } }
  expect(codingVibeProgressOf(withoutCleanup)).toMatchObject({ stage: "admitted" })
})
