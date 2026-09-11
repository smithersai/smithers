import { describe, expect, test } from "bun:test"
import { decodeSweep, MAX_SWEEP_REQUEST_BYTES, MAX_SWEEP_RESPONSE_BYTES, sweepConversation } from "./ConversationSweep"

const note = { title: "Keep", body: "A fact", confidence: 0.9 }
const delta = (value: unknown) => ({ type: "delta", kind: "text", text: JSON.stringify(value) })
const done = { type: "done", reason: "stop" }
const ndjson = (...frames: unknown[]) => frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n"
const good = () => ndjson(delta({ notes: [note] }), done)

describe("summary admission", () => {
  test("accepts complete output only and never promotes reasoning", () => {
    expect(decodeSweep(ndjson({ type: "delta", kind: "reasoning", text: "not JSON" }, delta({ notes: [note] }), done)))
      .toEqual([note])
    expect(decodeSweep(ndjson(delta({ notes: [] }), done))).toEqual([])
  })

  const failures: Record<string, string> = {
    "missing terminal": ndjson(delta({ notes: [note] })),
    "missing success reason": ndjson(delta({ notes: [note] }), { type: "done" }),
    "cancellation": ndjson(delta({ notes: [note] }), { type: "done", reason: "cancelled" }),
    "truncation": ndjson(delta({ notes: [note] }), { type: "done", reason: "length" }),
    "tool limit": ndjson(delta({ notes: [note] }), { type: "done", reason: "tool_limit" }),
    "terminal error": ndjson(delta({ notes: [note] }), { ...done, error: "failure" }),
    "earlier error": ndjson({ type: "error", message: "failed" }, delta({ notes: [note] }), done),
    "trailing error": good() + ndjson({ type: "error" }),
    "second terminal": good() + ndjson(done),
    "trailing delta": good() + ndjson(delta({ notes: [] })),
    "malformed wire": "not JSON\n" + good(),
    "null frame": "null\n" + good(),
    "tool call": ndjson({ type: "tool_call" }, delta({ notes: [note] }), done),
    "mixed run ids": ndjson({ ...delta({ notes: [note] }), runId: "one" }, { ...done, runId: "two" }),
    "invalid note in otherwise valid batch": ndjson(delta({ notes: [note, { title: "bad" }] }), done),
    "empty title": ndjson(delta({ notes: [{ ...note, title: "  " }] }), done),
    "empty body": ndjson(delta({ notes: [{ ...note, body: "" }] }), done),
    "missing confidence": ndjson(delta({ notes: [{ title: "x", body: "y" }] }), done),
    "out of range confidence": ndjson(delta({ notes: [{ ...note, confidence: 2 }] }), done),
    "invented provenance": ndjson(delta({ notes: [{ ...note, sources: ["user:world-editor"] }] }), done),
    "oversized title": ndjson(delta({ notes: [{ ...note, title: "x".repeat(161) }] }), done),
    "oversized body": ndjson(delta({ notes: [{ ...note, body: "x".repeat(16_385) }] }), done),
    "too many notes": ndjson(delta({ notes: Array.from({ length: 51 }, () => note) }), done),
    "fenced output": ndjson({ type: "delta", kind: "text", text: "```json\n{\"notes\":[]}\n```" }, done),
    "prose prefix": ndjson({ type: "delta", kind: "text", text: "Here: {\"notes\":[]}" }, done)
  }
  for (const [name, wire] of Object.entries(failures)) {
    test(`rejects ${name} without salvaging partial notes`, () => {
      expect(() => decodeSweep(wire)).toThrow()
    })
  }
})

describe("bounded summary transport", () => {
  test("refuses oversized UTF-8 requests before any fetch", async () => {
    let calls = 0
    await expect(sweepConversation(
      async () => {
        calls++
        return new Response(good())
      },
      "http://test",
      [{ role: "user", content: "😀".repeat(MAX_SWEEP_REQUEST_BYTES / 4) }],
      new AbortController().signal
    )).rejects.toThrow("request limit")
    expect(calls).toBe(0)
  })

  test("reads split UTF-8 characters and split frames", async () => {
    const bytes = new TextEncoder().encode(ndjson(delta({ notes: [{ ...note, body: "😀" }] }), done))
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
        controller.close()
      }
    })
    const notes = await sweepConversation(
      async () => new Response(body),
      "http://test",
      [],
      new AbortController().signal
    )
    expect(notes[0]?.body).toBe("😀")
  })

  test("oversized response cancels a body that has not ended", async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_SWEEP_RESPONSE_BYTES + 1))
      },
      cancel() {
        cancelled = true
      }
    })
    await expect(sweepConversation(async () => new Response(body), "http://test", [], new AbortController().signal))
      .rejects.toThrow()
    expect(cancelled).toBe(true)
  })

  test("deadline covers a body stalled after a syntactically valid summary", async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(good()))
      },
      cancel() {
        cancelled = true
      }
    })
    await expect(sweepConversation(async () => new Response(body), "http://test", [], new AbortController().signal, 10))
      .rejects.toThrow()
    expect(cancelled).toBe(true)
  })

  test("deadline aborts a stalled fetch, including one ignoring its signal", async () => {
    let signal: AbortSignal | null | undefined
    await expect(sweepConversation(
      async (_input, init) => {
        signal = init?.signal
        return new Promise<Response>(() => {})
      },
      "http://test",
      [],
      new AbortController().signal,
      10
    )).rejects.toThrow()
    expect(signal?.aborted).toBe(true)
  })

  test("disposing an operation cancels the body and rejects immediately", async () => {
    const abort = new AbortController()
    let cancelled = false
    let opened!: () => void
    const ready = new Promise<void>((resolve) => {
      opened = resolve
    })
    const pending = sweepConversation(
      async () => {
        const body = new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true
          }
        })
        queueMicrotask(opened)
        return new Response(body)
      },
      "http://test",
      [],
      abort.signal
    )
    const result = pending.then(() => "resolved", () => "rejected")
    await ready
    abort.abort()
    expect(await result).toBe("rejected")
    expect(cancelled).toBe(true)
  })

  for (
    const response of [
      () => new Response("refused", { status: 500 }),
      () => new Response(null),
      () => new Response(new Uint8Array([0xff]))
    ]
  ) {
    test("rejects unsuccessful, missing or invalid UTF-8 bodies", async () => {
      await expect(sweepConversation(async () => response(), "http://test", [], new AbortController().signal)).rejects
        .toThrow()
    })
  }
})
