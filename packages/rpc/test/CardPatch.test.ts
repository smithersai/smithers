import { describe, expect, test } from "vitest"
import { AgentTurnBatchSchema } from "../src/AgentTurnJournal.ts"
import { CardPatchSchema, CardSchema } from "../src/Cards.ts"
import { AgentTurnFrameSchema } from "../src/NativeAgent.ts"
import { fixtures as draftFixtures } from "./fixtures/Draft.ts"

const base = { id: "card-1", title: "Agents", status: "active", createdAt: 0, ordinal: 0 }
const model = { id: "model-1", protocol: "openai-responses", modelId: "model-1", credential: "OPENAI_API_KEY" }
const session = {
  id: "session-1",
  title: "Review",
  status: "running",
  messageCount: 0,
  createdAt: null,
  workspaceId: null
}

describe("agents shallow patches", () => {
  test.each([
    {},
    { selectedAgent: "ui" },
    { selectedModel: "model-1" },
    { testing: ["ui"] },
    { testRequests: { ui: { requestId: "request-1", model } } },
    { assignment: { id: "request-1", role: "ui", model: "model-1", state: "requested" } },
    { native: false },
    { agents: [] },
    { inventory: "repository" },
    { canAssign: true },
    { cloud: true },
    { repo: "org/repo" },
    { sessions: [session] },
    { cloud: true, repo: "org/repo", sessions: [session] }
  ])("preserves the supplied fields through patches, frames and batches: %j", (payload) => {
    const patch = { kind: "agents", payload }
    const frame = { runId: "run-1", type: "card.update", id: base.id, patch }
    const batch = {
      version: 1,
      runId: "run-1",
      legId: "leg-1",
      batch: 1,
      from: 1,
      previousHash: "a".repeat(64),
      frames: [frame],
      hash: "b".repeat(64)
    }
    expect(CardPatchSchema.parse(patch)).toEqual(patch)
    expect(AgentTurnFrameSchema.parse(frame)).toEqual(frame)
    expect(AgentTurnBatchSchema.parse(batch)).toEqual(batch)
  })

  test.each([
    { selectedAgent: 1 },
    { selectedModel: false },
    { testing: [1] },
    { native: "false" },
    { agents: [null] },
    { inventory: "unknown" },
    { assignment: { id: "request-1" } },
    { assignment: { id: "request-1", role: "ui", model: "model-1", state: "ready" } },
    { testRequests: { ui: { requestId: "request-1" } } },
    { cloud: false },
    { repo: 1 },
    { sessions: [{ id: "session-1" }] },
    { sessions: [{ ...session, messageCount: -1 }] }
  ])("refuses invalid supplied fields and incomplete nested values: %j", (payload) => {
    expect(CardPatchSchema.safeParse({ kind: "agents", payload }).success).toBe(false)
  })

  test.each([
    { native: false, agents: [] },
    { cloud: true, repo: "org/repo", sessions: [session] }
  ])("merges a partial update into a valid existing branch: %j", (payload) => {
    const update = "native" in payload ? { selectedAgent: "ui" } : { repo: "org/next" }
    const patch = CardPatchSchema.parse({ kind: "agents", payload: update })
    const row = { ...base, kind: "agents", payload: { ...payload, ...patch.payload } }
    expect(CardSchema.parse(row)).toEqual(row)
  })

  test.each([{ selectedAgent: "ui" }, { sessions: [session] }])("strips unrelated fields: %j", (payload) => {
    expect(CardPatchSchema.parse({ kind: "agents", payload: { ...payload, unknown: "discard" } }))
      .toEqual({ kind: "agents", payload })
  })
})

describe("draft issue source links", () => {
  const payload = (url: string) => ({
    ...draftFixtures.append.model,
    idempotencyKey: "draft-1",
    issuePreparation: {
      source: { number: 1, title: "Issue", body: "Description", url, comments: [] },
      state: "requested"
    }
  })

  test.each(["https://example.com/issues/1", "http://example.com/issues/1", "HTTPS://example.com/issues/1"])(
    "preserves an http(s) source URL in cards and patches: %s",
    (url) => {
      const value = payload(url)
      const row = { ...base, audience_member_id: "author", kind: "draft", payload: value }
      expect(CardSchema.parse(row)).toEqual(row)
      const patch = { kind: "draft", payload: { issuePreparation: value.issuePreparation } }
      expect(CardPatchSchema.parse(patch)).toEqual(patch)
    }
  )

  test.each(["javascript:alert(1)", "data:text/html,unsafe", "file:///secret", "//example.com/issue", "/issue", ""])(
    "refuses an unsafe or nonabsolute source URL in cards and patches: %s",
    (url) => {
      const value = payload(url)
      expect(CardSchema.safeParse({ ...base, audience_member_id: "author", kind: "draft", payload: value }).success)
        .toBe(false)
      expect(
        CardPatchSchema.safeParse({ kind: "draft", payload: { issuePreparation: value.issuePreparation } }).success
      )
        .toBe(false)
    }
  )
})
