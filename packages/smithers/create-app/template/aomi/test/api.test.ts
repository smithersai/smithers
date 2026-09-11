/**
 * The wire contract. Both the browser shell and the Worker decode with these
 * schemas, so a field that encodes here but does not decode back is a
 * cross-process bug that no single-side test would catch.
 */
import { AppCard, HtmlCard, PaneCard, TurnFrame } from "@smthrs/create-app/ui"
import * as Schema from "effect/Schema"
import { describe, expect, test } from "vitest"
import {
  CancelRequest,
  CancelResponse,
  FlowList,
  FlowRunRequest,
  FlowRunResponse,
  Message,
  Routes,
  SessionList,
  SessionState,
  SessionSummary,
  TurnRequest
} from "../src/api.ts"

/** Encode then decode: the value that comes back must equal the value that went in. */
const roundTrip = <A, E>(schema: Schema.Codec<A, E>, value: A): A =>
  Schema.decodeUnknownSync(schema)(Schema.encodeSync(schema)(value) as unknown)

describe("Routes", () => {
  test("every route is an absolute /api path", () => {
    for (const path of Object.values(Routes)) expect(path.startsWith("/api/")).toBe(true)
  })
})

describe("TurnRequest", () => {
  test("round-trips", () => {
    const value: TurnRequest = { sessionId: "s1", flowId: "chat", message: "What is vitalik.eth's balance?" }
    expect(roundTrip(TurnRequest, value)).toEqual(value)
  })

  test("rejects a missing field", () => {
    expect(() => Schema.decodeUnknownSync(TurnRequest)({ sessionId: "s1", flowId: "chat" })).toThrow()
  })

  test("rejects a non-string message", () => {
    expect(() => Schema.decodeUnknownSync(TurnRequest)({ sessionId: "s1", flowId: "chat", message: 7 })).toThrow()
  })
})

describe("CancelRequest", () => {
  test("round-trips", () => {
    expect(roundTrip(CancelRequest, { sessionId: "s1" })).toEqual({ sessionId: "s1" })
  })
})

describe("Message", () => {
  test("accepts every role", () => {
    for (const role of ["user", "assistant", "system"] as const) {
      const value: Message = { id: "m1", role, text: "hi", at: 1 }
      expect(roundTrip(Message, value)).toEqual(value)
    }
  })

  test("rejects an unknown role", () => {
    expect(() => Schema.decodeUnknownSync(Message)({ id: "m1", role: "tool", text: "hi", at: 1 })).toThrow()
  })
})

describe("SessionState", () => {
  const state: SessionState = {
    id: "s1",
    messages: [
      { id: "m1", role: "user", text: "balance of vitalik.eth", at: 1 },
      { id: "m2", role: "assistant", text: "1.2 ETH", at: 2 }
    ],
    cards: [
      { kind: "pane", id: "c1", name: "balances", props: { address: "0xabc" }, fullscreen: false },
      { kind: "html", id: "c2", html: "<p>ok</p>" }
    ],
    entries: [
      { kind: "message", messageId: "m1" },
      { kind: "card", cardId: "c1" },
      { kind: "message", messageId: "m2" },
      { kind: "card", cardId: "c2" }
    ],
    busy: false
  }

  test("round-trips messages and cards together", () => {
    expect(roundTrip(SessionState, state)).toEqual(state)
  })

  test("keeps an empty session decodable", () => {
    const empty: SessionState = { id: "s2", messages: [], cards: [], busy: true }
    expect(roundTrip(SessionState, empty)).toEqual(empty)
  })

  test("round-trips an explicitly empty entry sequence", () => {
    const empty: SessionState = { id: "s2", messages: [], cards: [], entries: [], busy: false }
    expect(roundTrip(SessionState, empty)).toEqual(empty)
  })

  test("rejects a card with an unknown kind", () => {
    expect(() =>
      Schema.decodeUnknownSync(SessionState)({
        id: "s1",
        messages: [],
        cards: [{ kind: "chart", id: "c1" }],
        busy: false
      })
    ).toThrow()
  })
})

describe("SessionSummary", () => {
  const summary: SessionSummary = { id: "s1", title: "arb bot", status: "ready", stage: "build", at: 3 }

  test("round-trips", () => {
    expect(roundTrip(SessionSummary, summary)).toEqual(summary)
  })

  test("accepts every status the Recent column renders", () => {
    for (const status of ["ready", "running", "failed", "idle"] as const) {
      expect(roundTrip(SessionSummary, { ...summary, status })).toEqual({ ...summary, status })
    }
  })

  test("rejects a status outside the union", () => {
    expect(() => Schema.decodeUnknownSync(SessionSummary)({ ...summary, status: "queued" })).toThrow()
  })

  test("rejects a missing stage", () => {
    expect(() => Schema.decodeUnknownSync(SessionSummary)({ id: "s1", title: "t", status: "ready", at: 1 })).toThrow()
  })
})

describe("SessionList", () => {
  test("round-trips an empty column", () => {
    expect(roundTrip(SessionList, { sessions: [] })).toEqual({ sessions: [] })
  })

  test("round-trips many rows", () => {
    const list: SessionList = {
      sessions: [
        { id: "s2", title: "newest", status: "running", stage: "build", at: 20 },
        { id: "s1", title: "older", status: "ready", stage: "chat", at: 10 }
      ]
    }
    expect(roundTrip(SessionList, list)).toEqual(list)
  })
})

describe("FlowRunResponse", () => {
  test("round-trips", () => {
    expect(roundTrip(FlowRunResponse, { executionId: "x1" })).toEqual({ executionId: "x1" })
  })

  test("rejects a missing execution id", () => {
    expect(() => Schema.decodeUnknownSync(FlowRunResponse)({})).toThrow()
  })
})

describe("CancelResponse", () => {
  test("round-trips both answers", () => {
    for (const cancelled of [true, false]) {
      expect(roundTrip(CancelResponse, { cancelled })).toEqual({ cancelled })
    }
  })

  test("rejects a non-boolean", () => {
    expect(() => Schema.decodeUnknownSync(CancelResponse)({ cancelled: "yes" })).toThrow()
  })
})

describe("FlowList", () => {
  test("round-trips both sources", () => {
    const list = {
      flows: [
        { id: "chat", description: "The Build page conversation", source: "file" as const, chat: true },
        { id: "saved/arb", description: "Promoted from a session", source: "saved" as const, chat: false }
      ]
    }
    expect(roundTrip(FlowList, list)).toEqual(list)
  })

  test("rejects an unknown source", () => {
    expect(() =>
      Schema.decodeUnknownSync(FlowList)({ flows: [{ id: "x", description: "", source: "remote", chat: false }] })
    ).toThrow()
  })
})

describe("FlowRunRequest", () => {
  test("carries an opaque payload", () => {
    const value = { sessionId: "s1", flowId: "build", payload: { topic: "arb bot", depth: 2 } }
    expect(roundTrip(FlowRunRequest, value)).toEqual(value)
  })
})

describe("cards", () => {
  test("PaneCard round-trips with and without a title", () => {
    const bare: PaneCard = { kind: "pane", id: "c1", name: "balances", props: {}, fullscreen: false }
    const titled: PaneCard = { ...bare, id: "c2", title: "Balances", fullscreen: true }
    expect(roundTrip(PaneCard, bare)).toEqual(bare)
    expect(roundTrip(PaneCard, titled)).toEqual(titled)
  })

  test("PaneCard requires fullscreen", () => {
    expect(() => Schema.decodeUnknownSync(PaneCard)({ kind: "pane", id: "c1", name: "balances", props: {} })).toThrow()
  })

  test("HtmlCard round-trips", () => {
    const value: HtmlCard = { kind: "html", id: "c3", title: "Report", html: "<h1>hi</h1>" }
    expect(roundTrip(HtmlCard, value)).toEqual(value)
  })

  test("AppCard discriminates on kind", () => {
    const run: AppCard = {
      kind: "flow-run",
      id: "c4",
      flowId: "build",
      executionId: "x1",
      phase: "running",
      steps: [{ name: "plan", status: "done" }, { name: "write", status: "running" }]
    }
    const saved: AppCard = {
      kind: "flow-saved",
      id: "c5",
      flowId: "arb",
      description: "arb scan",
      files: ["flows/arb/flow.ts", "flows/arb/flow.e2e.ts"]
    }
    expect(roundTrip(AppCard, run)).toEqual(run)
    expect(roundTrip(AppCard, saved)).toEqual(saved)
  })
})

describe("TurnFrame", () => {
  const frames: ReadonlyArray<TurnFrame> = [
    { type: "delta", text: "thinking" },
    { type: "cell", source: "return { intent: \"complete\" }", ordinal: 0 },
    { type: "call", flow: "tevm/getBalance", input: { address: "0xabc" }, outcome: "success" },
    { type: "call", flow: "tevm/getBalance", input: {}, outcome: "failure", message: "no fork" },
    { type: "card", card: { kind: "html", id: "c1", html: "<p>hi</p>" } },
    { type: "card.update", card: { kind: "html", id: "c1", html: "<p>bye</p>" } },
    { type: "park", reason: "approval", message: "deploy needs approval" },
    { type: "done", output: { answer: "1.2 ETH" } },
    { type: "error", message: "rate limited" }
  ]

  test("every frame round-trips", () => {
    for (const frame of frames) expect(roundTrip(TurnFrame, frame)).toEqual(frame)
  })

  test("covers every declared frame type", () => {
    const declared = TurnFrame.members.map((member) => member.fields.type.literal)
    expect(new Set(frames.map((frame) => frame.type))).toEqual(new Set(declared))
  })

  test("rejects an unknown frame type", () => {
    expect(() => Schema.decodeUnknownSync(TurnFrame)({ type: "tool", name: "x" })).toThrow()
  })

  test("rejects a call frame with an unknown outcome", () => {
    expect(() =>
      Schema.decodeUnknownSync(TurnFrame)({ type: "call", flow: "a/b", input: {}, outcome: "maybe" })
    ).toThrow()
  })
})
