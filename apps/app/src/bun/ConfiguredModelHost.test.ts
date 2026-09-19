import { describe, expect, test } from "bun:test"
import { Message } from "@smthrs/model/ModelRequest"
import type { AgentTurnFrame } from "@smthrs/rpc/NativeAgent"
import { Effect } from "effect"
import { credentialCut, planOnLocal, sealedTurn } from "./ConfiguredModelHost"

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

describe("the cut a turn's text passes through", () => {
  const through = (deltas: ReadonlyArray<string>, secret = KEY): ReadonlyArray<string> => {
    const cut = credentialCut(secret)
    return [...deltas.map(cut.push), cut.flush()]
  }

  test("text with nothing of the value in it passes delta by delta, none held", () => {
    expect(through(["loopback ", "pong"])).toEqual(["loopback ", "pong", ""])
  })

  test("the value is cut wherever the deltas break it", () => {
    for (let at = 1; at < KEY.length; at += 1) {
      const out = through([`a ${KEY.slice(0, at)}`, `${KEY.slice(at)} b`])
      expect(out.join("")).toBe("a  b")
    }
    expect(through([...`x${KEY}y${KEY}z`]).join("")).toBe("xyz")
  })

  test("a tail that only began like the value is published at the end, not lost", () => {
    expect(through(["ends with sk-ho"])).toEqual(["ends with ", "sk-ho"])
    expect(through(["sk-ho", "st of the party"]).join("")).toBe("sk-host of the party")
  })

  test("no held tail is ever the value, and an empty value cuts nothing", () => {
    expect(through([KEY, KEY.slice(0, -1)]).join("")).toBe(KEY.slice(0, -1))
    expect(through(["a", "b"], "")).toEqual(["a", "b", ""])
  })
})

describe("a sealed turn", () => {
  const planned = () => {
    const plan = planOnLocal(
      { protocol: "openai-chat", baseUrl: ORIGIN, modelId: "lab", credential: "LAB" },
      { SMITHERS_MODEL_KEY_LAB: KEY, SMITHERS_MODEL_KEY_LAB_ORIGIN: ORIGIN }
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
  const run = async (fetchImpl: typeof fetch): Promise<ReadonlyArray<AgentTurnFrame>> => {
    const frames: Array<AgentTurnFrame> = []
    await Effect.runPromise(
      sealedTurn(planned(), { runId: "r", instructions: "", messages: [Message.user("hi")] }, (frame) => frames.push(frame), fetchImpl)
    )
    return frames
  }

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
