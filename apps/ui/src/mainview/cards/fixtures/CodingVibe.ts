import { readFileSync } from "node:fs"
import { Schema } from "effect"
import { RequestInput, RequestResult } from "../../../../../../flows/coding/schema.ts"
import { codingDecision } from "./CodingJournal"
import type { Card } from "../../state/AppState"

/** Actual Node/JJ/SQLite host completion, retained unchanged from the native acceptance. */
export const CODING_REQUEST_EVENTS: Array<Record<string, unknown>> = readFileSync(new URL("./CodingHostDecisions.ndjson", import.meta.url), "utf8")
  .trim().split("\n").map(line => JSON.parse(line))
const terminal = CODING_REQUEST_EVENTS.map(event => event.payload as {
  executionId: string; payload: { status?: string; state?: { flowName?: string; payload?: unknown; result?: { exit?: { value?: unknown } } } }
}).find(row => row.payload.status === "completed" && row.payload.state?.flowName === "coding/Request")!
export const CODING_REQUEST_ID = terminal.executionId
export const CODING_REQUEST_RESULT = Schema.decodeUnknownSync(RequestResult)(terminal.payload.state!.result!.exit!.value)
export const CODING_REQUEST_INPUT = Schema.decodeUnknownSync(RequestInput)(terminal.payload.state!.payload)
export const completedRequestCard = (): Extract<Card, { kind: "run-trace" }> => ({
  id: "completed-request", kind: "run-trace", title: "Coding request", status: "active", ordinal: 1, createdAt: 0,
  payload: { repo: "smithersai/smithers", gatewayBindingVersion: 1, runId: "run-1", workflow: "coding/request", phase: "completed",
    input: CODING_REQUEST_INPUT, steps: [], result: null, lastSeq: 329, events: CODING_REQUEST_EVENTS }
})
export const vibeCatalog = (): Extract<Card, { kind: "workflow-list" }> => ({
  id: "catalog", kind: "workflow-list", title: "Flows", status: "active", ordinal: 2, createdAt: 1,
  payload: { repo: "smithersai/smithers", gatewayBindingVersion: 1,
    workflows: [{ key: "coding/vibe", description: "Finalize validated changes" }] }
})

/** Synthetic writer envelopes around the real request receipt for finalization projection tests. */
export const VIBE_ADMISSION = {
  requestExecutionId: CODING_REQUEST_ID, controlRunId: "run-1", planId: "plan-1", planDigest: "retained-plan-digest",
  pocExecutionId: "retained-poc", originalSource: CODING_REQUEST_RESULT.plan.base,
  request: CODING_REQUEST_RESULT, validatedHead: CODING_REQUEST_RESULT.outcome.result!.changes.at(-1)!.implementation.head
}

/** Actual request sources in scripted native publication child envelopes. */
export const publicationVibeCard = (): Extract<Card, { kind: "run-trace" }> => {
  const workspaceId = "83e75ae5-0920-4000-8000-000000000001"
  const input = { requestExecutionId: CODING_REQUEST_ID }
  const cleanup = { admission: VIBE_ADMISSION, summary: "✨ feat: retain the validated greeting", result: VIBE_ADMISSION.request.outcome.result!, head: VIBE_ADMISSION.validatedHead }
  const publication = (source: typeof VIBE_ADMISSION.originalSource) => ({ status: "retained", workspaceId, repositoryId: 42,
    requestId: "12345678-1234-1234-1234-123456789abc", ref: `refs/smithers/workspaces/${workspaceId}/sources/${source.commitId}`,
    source: { changeId: source.changeId, commitId: source.commitId, treeId: source.treeId, parentCommitIds: source.parentCommitIds } })
  const card = completedRequestCard()
  return { ...card, id: "vibe-card", payload: { ...card.payload, workspaceId, workflow: "coding/vibe", runId: "vibe-root", phase: "running", input, events: [
    codingDecision(1, "vibe-root", "agent/run", { status: "running", input: { planId: "vibe-plan" } }),
    codingDecision(2, "vibe-bridge", "coding/vibe", { parent: "vibe-root", status: "running", input: { input } }),
    codingDecision(3, "vibe", "coding/Vibe", { parent: "vibe-bridge", status: "running", input }),
    codingDecision(4, "admission", "coding/AdmitVibe", { parent: "vibe", status: "running", input }),
    codingDecision(5, "original-publication", "coding/PublishVibeSource", { parent: "admission", status: "completed",
      input: { phase: "original", source: VIBE_ADMISSION.originalSource }, value: publication(VIBE_ADMISSION.originalSource) }),
    codingDecision(6, "admission", "coding/AdmitVibe", { parent: "vibe", status: "completed", input, value: VIBE_ADMISSION }),
    codingDecision(7, "cleanup", "coding/CleanVibeHistory", { parent: "vibe", status: "completed", value: cleanup }),
    codingDecision(8, "cleaned-publication", "coding/PublishVibeSource", { parent: "vibe", status: "completed",
      input: { phase: "cleaned", source: cleanup.head }, value: publication(cleanup.head) })
  ] } }
}
