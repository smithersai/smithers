import { describe, expect, test } from "bun:test"
import { Message } from "@smthrs/model/ModelRequest"
import type { AgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import { Effect } from "effect"
import { planOnLocal } from "@smthrs/model-host/LocalModel"
import { sealedTurn } from "./ConfiguredModelHost"

/*
 * What a sealed turn publishes when its provider says the credential back.
 * The provider here is a fetch that answers the OpenAI chat SSE wire, because
 * the cases are about where a stream is cut, which no real server lets a test
 * choose byte for byte. The over-TCP echo is in server.test.ts.
 */
const KEY = "sk-host-REDACTME-0123456789abcdef"
const ORIGIN = "http://127.0.0.1:9"

const said = (frames: ReadonlyArray<AgentTurnFrame>): string =>
  frames.flatMap((frame) => frame.type === "delta" ? [frame.text] : []).join("")

const partitions = (text: string): ReadonlyArray<ReadonlyArray<string>> => {
  if (text.length === 0) return [[]]
  return Array.from({ length: text.length }, (_, index) => index + 1)
    .flatMap((at) => partitions(text.slice(at)).map((tail) => [text.slice(0, at), ...tail]))
}

describe("a sealed turn", () => {
  const planned = (secret = KEY) => {
    const plan = planOnLocal(
      { protocol: "openai-chat", baseUrl: ORIGIN, modelId: "lab", credential: "LAB" },
      { SMITHERS_MODEL_KEY_LAB: secret, SMITHERS_MODEL_KEY_LAB_ORIGIN: ORIGIN }
    )
    if (!plan.ok) throw new Error(`not planned: ${plan.failure.code}`)
    return plan
  }
  const chunk = (content: string): string =>
    `data: ${JSON.stringify({ id: "c", object: ["chat", "completion", "chunk"].join("."), created: 1, model: "lab", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`
  const answering = (frames: (authorization: string) => ReadonlyArray<string>) =>
    (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(frames(new Headers(init?.headers).get("authorization") ?? "").join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      })) as unknown as typeof fetch
  const run = async (fetchImpl: typeof fetch, secret = KEY): Promise<ReadonlyArray<AgentTurnFrame>> => {
    const frames: Array<AgentTurnFrame> = []
    await Effect.runPromise(
      sealedTurn(planned(secret), { runId: "r", instructions: "", messages: [Message.user("hi")] }, (frame) => frames.push(frame), fetchImpl)
    )
    return frames
  }

  for (const failure of [false, true]) test(`cuts joined echoes under every partition, including on ${failure ? "failure" : "success"}`, async () => {
    for (const deltas of [["abab", "c", "c"], ...["abc", "abcabc", "ababcc"].flatMap(partitions)]) {
      const frames = await run(answering(() => [
        chunk("before "), ...deltas.map(chunk), chunk(" after"),
        failure ? "data: {not json\n\n" : "data: [DONE]\n\n"
      ]), "abc")
      expect(said(frames)).toBe("before  after")
      expect(frames).toEqual([
        { runId: "r", type: "delta", kind: "text", text: "before  after" },
        { runId: "r", type: "done", reason: "stop", ...(failure ? { error: "invalid · protocol" } : {}) }
      ])
    }
  })

  test("holds all text until the answer ends, then cuts a joined long credential", async () => {
    let release!: () => void
    let began!: () => void
    const started = new Promise<void>((resolve) => { began = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    const frames: Array<AgentTurnFrame> = []
    const fetchImpl = (async () => new Response(new ReadableStream({ async start(controller) {
      const at = Math.floor(KEY.length / 2)
      for (const delta of [KEY.slice(0, at).repeat(2), KEY.slice(at), KEY.slice(at)]) {
        controller.enqueue(new TextEncoder().encode(chunk(delta)))
      }
      began()
      await held
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
      controller.close()
    } }), { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch
    const pending = Effect.runPromise(sealedTurn(planned(), { runId: "r", instructions: "", messages: [Message.user("hi")] },
      (frame) => frames.push(frame), fetchImpl))
    try {
      await started
      await Bun.sleep(10)
      expect(frames).toEqual([])
    } finally {
      release()
      await pending
    }
    expect(frames).toEqual([{ runId: "r", type: "done", reason: "stop" }])
  })

  test("refuses output beyond the answer bound with sanitized partial text", async () => {
    const frames = await run(answering(() => [chunk(`safe ${KEY}`), chunk("x".repeat(128 * 1024)), "data: [DONE]\n\n"]))
    expect(said(frames)).toBe("safe ")
    expect(frames.at(-1)).toEqual({ runId: "r", type: "done", reason: "stop", error: "invalid · protocol" })
  })

  test("publishes the words around an echoed credential and never the value", async () => {
    const frames = await run(answering((authorization) => {
      const at = Math.floor(authorization.length / 2)
      return [
        chunk(`your key is ${authorization.slice(0, at)}`),
        chunk(`${authorization.slice(at)}, keep it safe`),
        `data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n"
      ]
    }))
    expect(JSON.stringify(frames)).not.toContain(KEY)
    expect(said(frames)).toBe("your key is Bearer , keep it safe")
    expect(frames.at(-1)).toEqual({ runId: "r", type: "done", reason: "stop" })
  })

  test("that fails mid-stream still publishes the tail it was holding, before the typed line", async () => {
    const frames = await run(answering(() => [chunk(`it starts ${KEY.slice(0, 5)}`), "data: {not json\n\n"]))
    expect(said(frames)).toBe(`it starts ${KEY.slice(0, 5)}`)
    expect(frames.at(-1)).toEqual({ runId: "r", type: "done", reason: "stop", error: "invalid · protocol" })
  })
})
