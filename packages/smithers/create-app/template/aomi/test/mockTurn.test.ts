import * as Schema from "effect/Schema"
import { describe, expect, it, vi } from "vitest"
import { flows } from "../routes.gen.ts"
import { panes } from "../routes.ui.gen.ts"
import { type AppCard, type Message, type SessionSummary, TurnFrame } from "../src/api.ts"
import type { Env } from "../worker/env.ts"
import { type FlowRoute, runFlowRun } from "../worker/flowRunImpl.ts"
import { liveRuntimeUnsupported, runTurn, type TurnSession } from "../worker/turnImpl.ts"

// The mock path never calls a chain tool. Keep the real flow registry and
// pane definitions, without initializing Tevm's live client dependencies.
vi.mock("../TOOLS.ts", () => ({ Tools: { sources: [] } }))
// The generated UI registry also imports the layout, whose virtual manifest
// is provided only by the app's Vite plugin, not by this Node test runner.
vi.mock("../app/layout.tsx", () => ({ default: () => null }))

const memorySession = () => {
  const messages: Array<Message> = []
  const cards = new Map<string, AppCard>()
  const statuses: Array<SessionSummary["status"]> = []
  const session: TurnSession = {
    appendMessage: (role, text) => {
      const message = { id: `message-${messages.length}`, role, text, at: 1 }
      messages.push(message)
      return message
    },
    appendCard: (card) => { cards.set(card.id, card) },
    writeFlow: () => { throw new Error("A mock turn must not write flows") },
    listFlows: () => [],
    settle: (status) => { statuses.push(status) }
  }
  return { session, messages, cards, statuses }
}

const turn = async (session: TurnSession, flowId = "chat"): Promise<Array<TurnFrame>> => {
  const body = runTurn({
    // The mock path needs no Cloudflare bindings or provider credentials.
    env: { APP_NAME: "mock-turn-test" } as Env,
    session,
    request: { sessionId: "session-1", flowId, message: "Check the balance" },
    signal: new AbortController().signal
  })
  const text = await new Response(body).text()
  return text.trim().split("\n").map((line) => Schema.decodeUnknownSync(TurnFrame)(JSON.parse(line)))
}

describe("the real mock turn", () => {
  it("emits and persists props accepted by every routed pane it names", async () => {
    const sink = memorySession()
    const frames = await turn(sink.session)
    const cards = frames.flatMap((frame) => frame.type === "card" ? [frame.card] : [])
    expect(cards).toHaveLength(1)
    for (const card of cards) {
      expect(card.kind).toBe("pane")
      if (card.kind !== "pane") throw new Error("Expected a pane card")
      const pane = Object.entries(panes).find(([name]) => name === card.name)?.[1]
      expect(pane).toBeDefined()
      if (pane === undefined) throw new Error(`Unrouted pane: ${card.name}`)
      Schema.decodeUnknownSync(pane.props as Schema.Codec<unknown>)(card.props)
      expect(card.name).toBe("chain-balance")
      const props = Schema.decodeUnknownSync(panes["chain-balance"].props)(card.props)
      expect(props).toEqual({
        chain: "mainnet",
        address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        native: { symbol: "ETH", amount: "1234567890123456789", decimals: 18 },
        tokens: []
      })
      expect(sink.cards.get(card.id)).toEqual(card)
    }
    expect(frames.at(-1)?.type).toBe("done")
    expect(sink.statuses).toEqual(["ready"])
  })

  it("keeps cards from two turns of the same session distinct", async () => {
    const sink = memorySession()
    const first = await turn(sink.session)
    const second = await turn(sink.session)
    const ids = [...first, ...second].flatMap((frame) => frame.type === "card" ? [frame.card.id] : [])
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect([...sink.cards.keys()]).toEqual(ids)
    expect(sink.statuses).toEqual(["ready", "ready"])
  })

  it.each([false, true])("fails an unrouted flow once (empty routes: %s)", async (empty) => {
    // Exercise the generated registry's empty-app case as well as a bad id.
    const registry = flows as unknown as Array<(typeof flows)[number]>
    const saved = [...registry]
    if (empty) registry.splice(0)
    try {
      const sink = memorySession()
      const frames = await turn(sink.session, "missing")
      expect(frames).toEqual([{ type: "error", message: 'No flow is routed as "missing".' }])
      expect(sink.statuses).toEqual(["failed"])
      expect(sink.messages).toEqual([])
      expect(sink.cards.size).toBe(0)
    } finally {
      if (empty) registry.push(...saved)
    }
  })
})

// The template ships no live implementation, so APP_MOCK_TURN=0 has exactly
// one answer on both entry points: the shared unsupported-runtime refusal.
describe("APP_MOCK_TURN=0", () => {
  const live = { APP_NAME: "mock-turn-test", APP_MOCK_TURN: "0" } as Env

  it("refuses a turn with one error frame and settles failed", async () => {
    const sink = memorySession()
    const body = runTurn({
      env: live,
      session: sink.session,
      request: { sessionId: "session-1", flowId: "chat", message: "Check the balance" },
      signal: new AbortController().signal
    })
    const text = await new Response(body).text()
    const frames = text.trim().split("\n").map((line) => Schema.decodeUnknownSync(TurnFrame)(JSON.parse(line)))
    expect(frames).toEqual([{ type: "error", message: liveRuntimeUnsupported }])
    expect(liveRuntimeUnsupported.startsWith("unsupported_runtime:")).toBe(true)
    expect(sink.statuses).toEqual(["failed"])
    expect(sink.messages).toEqual([])
  })

  it("refuses a pipeline run by settling its card failed", async () => {
    const frames: Array<TurnFrame> = []
    const phase = await runFlowRun({
      env: live,
      request: { sessionId: "session-1", flowId: "build", payload: {} },
      executionId: "exec-1",
      routes: async () => [{ id: "build" }] as unknown as ReadonlyArray<FlowRoute>,
      signal: new AbortController().signal,
      emit: (frame) => { frames.push(frame) }
    })
    expect(phase).toBe("failed")
    expect(frames).toEqual([{
      type: "card.update",
      card: {
        kind: "flow-run",
        id: "exec-1",
        flowId: "build",
        executionId: "exec-1",
        phase: "failed",
        steps: [],
        error: liveRuntimeUnsupported
      }
    }])
  })
})
