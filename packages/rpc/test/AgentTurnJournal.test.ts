import { describe, expect, test } from "vitest"
import {
  AGENT_TURN_READ_LIMIT_MAX,
  AgentConversationBatchSchema,
  AgentConversationReplaySchema,
  AgentTurnBatchRejected,
  AgentTurnJournalCommandSchema,
  agentTurnJournalDigestInput,
  AgentTurnJournalReplySchema,
  AgentTurnJournalRequestSchema,
  projectAgentTurnBatch
} from "../src/AgentTurnJournal.ts"
import type { AgentTurnBatch, AgentTurnJournalHead } from "../src/AgentTurnJournal.ts"

/*
 * The durable chat journal's admission rule: a batch is accepted only when it
 * extends the committed prefix exactly. Each guard clause gets one batch that
 * breaks it and nothing else.
 */

const hash = (digit: string): string => digit.repeat(64)

const head: AgentTurnJournalHead = {
  version: 1,
  acceptance: {
    version: 1,
    runId: "run-1",
    legId: "leg-1",
    ownerHash: hash("1"),
    accessHash: hash("2"),
    requestHash: hash("3"),
    writerHash: hash("4"),
    acceptedAt: 0,
    hash: hash("5")
  },
  cursor: { version: 1, runId: "run-1", legId: "leg-1", batch: 0, position: 0, hash: hash("6") },
  bytes: 0,
  terminal: false,
  hash: hash("7")
}

const delta = (text: string) => ({ runId: "run-1", type: "delta" as const, kind: "text" as const, text })

const batch: AgentTurnBatch = {
  version: 1,
  runId: "run-1",
  legId: "leg-1",
  batch: 1,
  from: 1,
  previousHash: hash("6"),
  frames: [delta("a"), delta("b")],
  hash: hash("8")
}

const refused = (previous: AgentTurnJournalHead, next: AgentTurnBatch) => () => projectAgentTurnBatch(previous, next)

describe("projectAgentTurnBatch", () => {
  test("a batch that extends the prefix advances the cursor, counts its bytes and stays open", () => {
    const projected = projectAgentTurnBatch(head, batch)
    expect(projected.cursor).toEqual({ ...head.cursor, batch: 1, position: 2, hash: hash("8") })
    expect(projected.bytes).toBeGreaterThan(0)
    expect(projected.terminal).toBe(false)
    expect(projected.acceptance).toBe(head.acceptance)
  })

  test("a done frame last closes the journal", () => {
    const closing = { ...batch, frames: [delta("a"), { runId: "run-1", type: "done" as const }] }
    expect(projectAgentTurnBatch(head, closing).terminal).toBe(true)
  })

  test("refuses a batch number that skips or repeats", () => {
    expect(refused(head, { ...batch, batch: 2 })).toThrow(AgentTurnBatchRejected)
    expect(refused({ ...head, cursor: { ...head.cursor, batch: 1 } }, batch)).toThrow(AgentTurnBatchRejected)
  })

  test("refuses a batch whose first position is not the next one", () => {
    expect(refused(head, { ...batch, from: 2 })).toThrow(AgentTurnBatchRejected)
  })

  test("refuses a batch linked to a different previous hash", () => {
    expect(refused(head, { ...batch, previousHash: hash("9") })).toThrow(AgentTurnBatchRejected)
  })

  test("refuses a batch for another run or another leg", () => {
    expect(refused(head, { ...batch, runId: "run-2" })).toThrow(AgentTurnBatchRejected)
    expect(refused(head, { ...batch, legId: "leg-2" })).toThrow(AgentTurnBatchRejected)
  })

  test("refuses a frame that names another run", () => {
    expect(refused(head, { ...batch, frames: [delta("a"), { ...delta("b"), runId: "run-2" }] })).toThrow(
      AgentTurnBatchRejected
    )
  })

  test("refuses a done frame anywhere but last", () => {
    expect(refused(head, { ...batch, frames: [{ runId: "run-1", type: "done" }, delta("a")] })).toThrow(
      AgentTurnBatchRejected
    )
  })

  test("a refusal is the tagged AgentTurnBatchRejected with its fixed sentence", () => {
    expect(refused(head, { ...batch, batch: 2 })).toThrowError(
      expect.objectContaining({
        _tag: "AgentTurnBatchRejected",
        name: "AgentTurnBatchRejected",
        message: "The turn batch does not extend its accepted prefix."
      })
    )
  })

  test("refuses any batch after the terminal head", () => {
    expect(refused({ ...head, terminal: true }, batch)).toThrow(AgentTurnBatchRejected)
  })
})

describe("agentTurnJournalDigestInput", () => {
  /* Persisted hashes are computed over this exact string; changing it orphans every stored journal. */
  test("pins the v1 domain separation and canonical key order", () => {
    expect(agentTurnJournalDigestInput("batch", { b: 1, a: "x" })).toBe(
      "smithers-agent-turn/batch/v1:{\"a\":\"x\",\"b\":1}"
    )
    expect(agentTurnJournalDigestInput("access", "token")).toBe("smithers-agent-turn/access/v1:\"token\"")
  })
})

describe("AgentConversationBatchSchema", () => {
  test("an archived batch keeps each frame's original bytes, including fields the live frame drops", () => {
    const archived = { ...batch, frames: [{ ...delta("a"), signature: "sig-a" }] }
    expect(AgentConversationBatchSchema.parse(archived).frames).toEqual([{ ...delta("a"), signature: "sig-a" }])
  })

  test("a frame the live schema refuses is refused with the live schema's issues", () => {
    const parsed = AgentConversationBatchSchema.safeParse({ ...batch, frames: [{ runId: "run-1", type: "teleport" }] })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues.every((issue) => issue.path[0] === "frames" && issue.path[1] === 0)).toBe(true)
  })
})

describe("journal reply pages", () => {
  const cursor = head.cursor
  const batches = (count: number) => Array.from({ length: count }, (_, index) => ({ ...batch, batch: index + 1 }))
  const page = (count: number) => ({
    status: "ok" as const,
    after: cursor,
    next: cursor,
    head: cursor,
    terminal: false,
    more: true,
    batches: batches(count)
  })
  const read = (limit: number) => ({
    operation: "read",
    ownerHash: hash("1"),
    accessHash: hash("2"),
    after: null,
    limit
  })

  test("a read asks for at most one page, and a reply carries at most that many batches", () => {
    expect(AGENT_TURN_READ_LIMIT_MAX).toBe(16)
    expect(AgentTurnJournalCommandSchema.safeParse(read(AGENT_TURN_READ_LIMIT_MAX)).success).toBe(true)
    expect(AgentTurnJournalCommandSchema.safeParse(read(AGENT_TURN_READ_LIMIT_MAX + 1)).success).toBe(false)
    const full = AgentTurnJournalReplySchema.parse(page(AGENT_TURN_READ_LIMIT_MAX))
    expect(full.status === "ok" && full.batches.length).toBe(AGENT_TURN_READ_LIMIT_MAX)
    const over = AgentTurnJournalReplySchema.safeParse(page(AGENT_TURN_READ_LIMIT_MAX + 1))
    expect(over.success).toBe(false)
  })

  test("a conversation replay page has the same bound", () => {
    const replay = (count: number) => ({ status: "ok", conversationId: "c-1", userText: "hi", page: page(count) })
    expect(AgentConversationReplaySchema.parse(replay(AGENT_TURN_READ_LIMIT_MAX)).page.batches).toHaveLength(
      AGENT_TURN_READ_LIMIT_MAX
    )
    const over = AgentConversationReplaySchema.safeParse(replay(AGENT_TURN_READ_LIMIT_MAX + 1))
    expect(over.success).toBe(false)
    expect(over.error?.issues.map((issue) => issue.path.join("."))).toEqual(["page.batches"])
  })
})

describe("journal read capabilities", () => {
  const request = (token: string) => ({ version: 1, legId: "leg-1", token })

  test.each([43, 44, 64, 127, 128])("accepts %i base64url characters without rewriting", (length) => {
    const value = request("a".repeat(length))
    expect(AgentTurnJournalRequestSchema.parse(value)).toEqual(value)
  })

  test.each([0, 1, 31, 32, 42, 129])("refuses a token of %i characters", (length) => {
    expect(AgentTurnJournalRequestSchema.safeParse(request("a".repeat(length))).success).toBe(false)
  })

  test("accepts the entire base64url alphabet", () => {
    const value = request("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
    expect(AgentTurnJournalRequestSchema.parse(value)).toEqual(value)
  })

  test.each(["+", "/", "=", " ", "\n", "é"])("refuses a non-base64url character: %j", (character) => {
    expect(AgentTurnJournalRequestSchema.safeParse(request("a".repeat(64) + character)).success).toBe(false)
  })
})
