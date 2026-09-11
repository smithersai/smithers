import { describe, expect, test } from "bun:test"
import type { Card } from "@smthrs/rpc/Cards"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { createCloudAgent } from "./CloudAgent"

const request: StartAgentTurnRequest = {
  runId: "run-1",
  messages: [{ role: "user", content: "Hello who are you" }],
  instructions: "Be brief."
}

const ndjsonResponse = (lines: ReadonlyArray<unknown>, init?: ResponseInit): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        for (const line of lines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`))
        controller.close()
      }
    }),
    { status: 200, ...init }
  )

/*
 * Turn streaming settles on the event loop, not on a wall clock: pump
 * macrotask turns until the predicate holds. The mocked streams enqueue
 * synchronously and every Effect step is promise-driven, so a settled turn is
 * observable within a bounded number of turns — a fixed setTimeout raced a
 * loaded machine instead.
 */
const until = async (predicate: () => boolean, what: string): Promise<void> => {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`the turn never settled: ${what}`)
}

/** A bounded number of event-loop turns, for assertions that something does NOT happen. */
const drain = async (turns = 50): Promise<void> => {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

describe("createCloudAgent", () => {
  test("each provider call has a fresh billing id while frames keep the caller id", async () => {
    const ids: Array<string> = []
    const frames: Array<AgentTurnFrame> = []
    const agent = createCloudAgent((frame) => frames.push(frame), {
      fetchImpl: async (_input, init) => {
        const id = new Headers(init?.headers).get("x-smithers-run-id")!
        ids.push(id)
        return ndjsonResponse([{ type: "card", card: { id: `card-${ids.length}`, kind: "approval", title: "Approve", status: "active", createdAt: 1, ordinal: 1,
          payload: { runId: id, capability: "read" } } }, { type: "done" }])
      }
    })
    expect(agent.start(request).status).toBe("started")
    await until(() => frames.filter((frame) => frame.type === "done").length === 1, "first billing call")
    await drain()
    expect(agent.start(request).status).toBe("started")
    await until(() => frames.filter((frame) => frame.type === "done").length === 2, "second billing call")
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1]); expect(ids).not.toContain(request.runId)
    expect(frames.every((frame) => frame.runId === request.runId)).toBe(true)
    expect(frames.flatMap((frame) => frame.type === "card" && frame.card.kind === "approval" ? [frame.card.payload.runId] : [])).toEqual([request.runId, request.runId])
  })

  test("streams upstream NDJSON frames to the publisher", async () => {
    const frames: AgentTurnFrame[] = []
    const agent = createCloudAgent((frame) => frames.push(frame), {
      chatUrl: "https://example.test/chat",
      origin: "https://example.test",
      fetchImpl: async () =>
        ndjsonResponse([
          { type: "delta", kind: "reasoning", text: "hmm" },
          { type: "delta", kind: "text", text: "Hello!" },
          { type: "done" }
        ])
    })

    expect(agent.start(request)).toEqual({ status: "started" })
    await until(() => frames.length === 3, "the three streamed frames")
    expect(frames).toEqual([
      { runId: "run-1", type: "delta", kind: "reasoning", text: "hmm" },
      { runId: "run-1", type: "delta", kind: "text", text: "Hello!" },
      { runId: "run-1", type: "done" }
    ])
  })

  test("publishes a done error frame when upstream responds with an HTTP failure", async () => {
    const frames: AgentTurnFrame[] = []
    const agent = createCloudAgent((frame) => frames.push(frame), {
      fetchImpl: async () => new Response("bad gateway", { status: 502 })
    })

    expect(agent.start(request)).toEqual({ status: "started" })
    await until(() => frames.some((frame) => frame.type === "done"), "the error frame")
    expect(frames).toEqual([
      {
        runId: "run-1",
        type: "done",
        error: "Smithers Cloud chat failed (HTTP 502): bad gateway"
      }
    ])
  })

  test("rejects a duplicate runId while a turn is active", () => {
    const agent = createCloudAgent(() => {}, {
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({ start: () => {} }), { status: 200 })
    })
    expect(agent.start(request)).toEqual({ status: "started" })
    expect(agent.start(request).status).toBe("error")
  })

  test("cancel aborts an active turn and reports not-found otherwise", async () => {
    const frames: AgentTurnFrame[] = []
    const agent = createCloudAgent((frame) => frames.push(frame), {
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({ start: () => {} }), { status: 200 })
    })
    expect(agent.cancel("run-1")).toEqual({ status: "not-found" })
    expect(agent.start(request)).toEqual({ status: "started" })
    expect(agent.cancel("run-1")).toEqual({ status: "cancelled" })
    await drain()
    expect(frames.some((frame) => frame.type === "done" && frame.error !== undefined)).toBe(false)
  })

  test("promotes upstream card frames into the shared turn contract", async () => {
    const planCard: Card = {
      id: "card-plan",
      kind: "plan",
      title: "Ship the MVP",
      status: "active",
      createdAt: 1,
      ordinal: 1,
      payload: { items: [{ id: "item-1", title: "Wave 1", status: "active" }] }
    }
    const frames: AgentTurnFrame[] = []
    const agent = createCloudAgent((frame) => frames.push(frame), {
      fetchImpl: async () =>
        ndjsonResponse([
          { type: "card", card: planCard },
          { type: "card.update", id: "card-plan", patch: { kind: "plan", status: "acted" } },
          { type: "card", card: { id: "card-bad", kind: "nonsense" } },
          { type: "done" }
        ])
    })

    expect(agent.start(request)).toEqual({ status: "started" })
    await until(() => frames.some((frame) => frame.type === "done"), "the card turn's done frame")
    expect(frames).toEqual([
      { runId: "run-1", type: "card", card: planCard },
      { runId: "run-1", type: "card.update", id: "card-plan", patch: { kind: "plan", status: "acted" } },
      { runId: "run-1", type: "done" }
    ])
  })

  test("cancel releases the turn's response stream (scoped transport)", async () => {
    /*
     * The AbortController transport aborted only the fetch promise: the
     * stream reader it had already handed out stayed open. The scoped
     * Effect transport releases the reader on interruption, so the
     * underlying stream sees its own cancel.
     */
    let streamCancelled = false
    let readerActive = false
    const agent = createCloudAgent(() => {}, {
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start: () => {},
            /* pull() fires only once the turn has acquired its reader. */
            pull: () => {
              readerActive = true
            },
            cancel: () => {
              streamCancelled = true
            }
          }),
          { status: 200 }
        )
    })
    expect(agent.start(request)).toEqual({ status: "started" })
    await until(() => readerActive, "the turn to acquire its reader")
    expect(agent.cancel("run-1")).toEqual({ status: "cancelled" })
    await until(() => streamCancelled, "the stream's own cancel")
    expect(streamCancelled).toBe(true)
  })

  test("a cancelled turn's teardown does not deregister the turn that replaced it", async () => {
    /*
     * The teardown runs after `cancel` already dropped the entry, so by then
     * the same run id can hold a replacement turn. Deleting by run id evicted
     * that live turn: it answered `not-found` to cancel and a second `start`
     * for it was permitted, leaving two fibers streaming one run.
     */
    const agent = createCloudAgent(() => {}, {
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({ start: () => {} }), { status: 200 })
    })
    expect(agent.start(request)).toEqual({ status: "started" })
    await drain()
    expect(agent.cancel("run-1")).toEqual({ status: "cancelled" })
    expect(agent.start(request)).toEqual({ status: "started" })
    await drain()
    expect(agent.cancel("run-1")).toEqual({ status: "cancelled" })
  })
})
