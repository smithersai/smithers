import { describe, expect, test } from "vitest"
import { decodeCommandsCall } from "../src/AgentCommands.ts"
import { CardSchema, LEGACY_CARD_KINDS } from "../src/Cards.ts"
import { AgentTurnFrameSchema } from "../src/NativeAgent.ts"

const base = { id: "recorded", title: "Recorded", status: "active", createdAt: 1, ordinal: 0 }

describe("RPC decoding regressions", () => {
  test.each([
    { action: "list", namespace: 7 },
    { action: "list", namespace: null },
    { action: "list", query: false },
    { action: "list", query: {} },
    { action: "execute", name: "files.read", args: 3 },
    { action: "execute", name: "files.read", args: null },
    { action: "execute", name: "files.read", args: [] }
  ])("commands reject incorrectly typed optional fields: %j", (input) => {
    expect(decodeCommandsCall(JSON.stringify(input))).toHaveProperty("failure")
  })

  test.each(LEGACY_CARD_KINDS)(
    "legacy %s retains recorded body and payload across decoding and agent frames",
    (kind) => {
      const payload = { nodes: [{ id: "step", status: "completed" }], events: [{ sequence: 1, text: "History" }] }
      const row = { ...base, kind, body: "Recorded body", payload }
      const before = structuredClone(row)
      const decoded = CardSchema.parse(row)
      expect(decoded).toMatchObject({ kind: "retired", body: row.body, payload: { was: kind, recorded: payload } })
      expect(CardSchema.parse(JSON.parse(JSON.stringify(decoded)))).toEqual(decoded)
      expect(AgentTurnFrameSchema.parse({ runId: "old", type: "card", card: row })).toEqual({
        runId: "old",
        type: "card",
        card: decoded
      })
      expect(row).toEqual(before)
    }
  )

  test("already retired cards retain recorded bodies and payloads", () => {
    const row = {
      ...base,
      kind: "retired",
      body: "Saved body",
      payload: { was: "history", recorded: [1, null, "event"] }
    }
    expect(CardSchema.parse(row)).toEqual(row)
  })

  test.each([["invalid"], [17], [true], [null]])(
    "retired cards reject malformed payload %j without throwing",
    (payload) => {
      expect(CardSchema.safeParse({ ...base, kind: "retired", payload }).success).toBe(false)
    }
  )

  test.each(["models", "model-call", "agent-models"])("retired %s keeps content while stripping credentials", (was) => {
    const row = {
      ...base,
      kind: "retired",
      body: "Recorded body",
      payload: { was, recorded: { apiKey: "saved-credential", request: { prompt: "Recorded prompt" } } }
    }
    const before = structuredClone(row)
    const decoded = CardSchema.parse(row)
    expect(decoded.payload).toEqual({ was, recorded: { request: { prompt: "Recorded prompt" } } })
    expect(CardSchema.parse(decoded)).toEqual(decoded)
    expect(row).toEqual(before)
  })

  test("retired environment records keep names and metadata without saved values", () => {
    const row = {
      ...base,
      kind: "retired",
      payload: { was: "env", recorded: { vars: [{ name: "TOKEN", value: "saved-credential" }, null, [], "old"] } }
    }
    const decoded = CardSchema.parse(row)
    expect(decoded.payload).toEqual({ was: "env", recorded: { vars: [{ name: "TOKEN" }, null, [], "old"] } })
    expect(CardSchema.parse(decoded)).toEqual(decoded)
  })

  test("declared cloud agents inventory is reachable and validates its sessions", () => {
    const row = {
      ...base,
      kind: "agents",
      payload: {
        cloud: true,
        repo: "org/repo",
        sessions: [{
          id: "session",
          title: "Review",
          status: "active",
          messageCount: 2,
          createdAt: null,
          workspaceId: null
        }]
      }
    }
    expect(CardSchema.parse(row)).toEqual(row)
    expect(CardSchema.parse({ ...row, payload: { ...row.payload, sessions: [] } }).kind).toBe("agents")
    expect(CardSchema.safeParse({ ...row, payload: { ...row.payload, sessions: [null] } }).success).toBe(false)
    expect(CardSchema.safeParse({ ...row, payload: { cloud: true } }).success).toBe(false)
  })

  test.each([[null], ["placeholder"], [17], [false]])("agent inventories reject malformed entry %j", (entry) => {
    expect(CardSchema.safeParse({ ...base, kind: "agents", payload: { native: false, agents: [entry] } }).success)
      .toBe(false)
  })
})
