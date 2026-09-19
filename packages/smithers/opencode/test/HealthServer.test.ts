import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as Protocol from "../src/Protocol.ts"
import * as Store from "../src/Store.ts"
import { serve, type Served, until } from "./Harness.ts"

/**
 * A scripted Jev: the health questions are answered from the facts the
 * server sends, so the color follows the run. A parked run reads as needing
 * a person; a frame with a demand reads as exploring; otherwise progressing.
 */
const jev: Evaluator.Script = (request) => {
  const state = request.state as { parked: string; demands: ReadonlyArray<string>; frame: number }
  const parked = state.parked !== "none"
  return {
    progress: {
      score: parked ? 1 : state.frame >= 2 ? 4 : 2,
      probabilities: { stuck: 0.05, exploring: 0.1, progressing: 0.7, verifying: 0.1, done: 0.05 }
    },
    stuck: { probability: 0.1 },
    needsHuman: { probability: parked ? 0.9 : 0.05 }
  }
}

let served: Served
beforeAll(() => {
  served = serve({ evaluator: Evaluator.layerScripted(jev) })
})
afterAll(() => served.dispose())

const get = async (path: string): Promise<unknown> => {
  const response = await served.handler(new Request(`http://test${path}`))
  expect(response.status).toBe(200)
  return response.json()
}

const post = (path: string, body: string) =>
  served.handler(
    new Request(`http://test${path}`, { method: "POST", body, headers: { "content-type": "application/json" } })
  )

describe("Health over the server", () => {
  it("dots the title, emits the health card on each color change, and reports the run", async () => {
    const session = (await (await post("/session", "{}")).json()) as Protocol.Session
    const stream = await served.handler(new Request("http://test/global/event"))
    const reader = stream.body!.getReader()
    const decoder = new TextDecoder()
    let buffered = ""
    const seen: Array<{ type: string; properties: Record<string, unknown> }> = []
    void (async () => {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buffered += decoder.decode(value)
        const frames = buffered.split("\n\n")
        buffered = frames.pop() ?? ""
        for (const frame of frames) {
          if (frame.startsWith("data: ")) seen.push(JSON.parse(frame.slice(6)).payload)
        }
      }
    })()
    await until(async () => seen.some((event) => event.type === "server.connected"))

    const prompted = await post(
      `/session/${session.id}/prompt_async`,
      JSON.stringify({ parts: [{ type: "text", text: "Read package.json and tell me the name field." }] })
    )
    expect(prompted.status).toBe(204)
    // Frame zero settles green; the park turns it red.
    await until(async () => seen.some((event) => event.type === "permission.asked"))
    await until(async () =>
      seen.some((event) =>
        event.type === "session.updated" && (event.properties["info"] as Protocol.Session).title.startsWith("🔴 ")
      )
    )
    const asked = seen.find((event) => event.type === "permission.asked")!
      .properties as unknown as Protocol.PermissionRequest
    const parked = (await get(`/session/${session.id}`)) as Protocol.Session
    expect(parked.title).toBe("🔴 Read package.json and tell me the name field.")

    const replied = await post(`/session/${session.id}/permissions/${asked.id}`, `{"response":"once"}`)
    expect(replied.status).toBe(200)
    await until(async () => seen.some((event) => event.type === "session.idle"))
    // The answer clears the park, so the dot goes to what the resumed run
    // earns (yellow, on the read-only demand it is still answering), and the
    // finished turn ends on the color its last state earned: green, and it
    // stays green (design F6). It never keeps "waiting for approval" over an
    // empty permission list, which is what the live drive left behind.
    await until(async () => ((await get(`/session/${session.id}`)) as Protocol.Session).title.startsWith("🟢 "))
    const titles = seen
      .filter((event) => event.type === "session.updated")
      .map((event) => (event.properties["info"] as Protocol.Session).title.slice(0, 2))
    expect(titles).toContain("🟢")
    expect(titles).toContain("🔴")
    expect(titles).toContain("🟡")

    const history = (await get(`/session/${session.id}/message?limit=20`)) as Array<Store.MessageWithParts>
    const assistant = history.find((item) => item.info.role === "assistant")!
    const tools = assistant.parts.filter((part): part is Protocol.ToolPart => part.type === "tool")
    const health = tools.filter((part) => part.tool === "health")
    // The stream carries the decisions in time order; the history sorts each
    // card under the frame whose settlement or park produced it: frame zero's
    // settle, then frame one's park and frame one's settle, in that order.
    const streamed = seen
      .filter((event) => event.type === "message.part.updated")
      .map((event) => event.properties["part"] as Protocol.Part)
      .filter((part): part is Protocol.ToolPart => part.type === "tool" && part.tool === "health")
      .map((part) => part.state.status === "completed" && part.state.title)
    expect(streamed).toEqual(["progressing", "waiting for approval", "read-only demanded", "done"])
    expect(health.map((part) => part.state.status === "completed" && part.state.title)).toEqual([
      "progressing",
      "waiting for approval",
      "read-only demanded",
      "done"
    ])
    const frameOf = (part: Protocol.Part) => Number.parseInt(part.id.slice(16, 20), 16)
    expect(health.map(frameOf)).toEqual([0, 1, 1, 1])
    expect(health[1]!.state.status === "completed" && health[1]!.state.output).toContain("needs a person: yes (90%)")
    expect(health[1]!.state.status === "completed" && health[1]!.state.metadata).toMatchObject({ color: "red" })
    const classify = tools.find((part) => part.tool === "classify")!
    expect(classify.state).toMatchObject({
      status: "completed",
      title: "triage/relevance · 1 state · 3 questions · 212 ms",
      output: "1. relevant: yes (0.93) · role: implementation (0.81) · risk: none (0.62)"
    })
    const summary = assistant.parts.find((part): part is Protocol.TextPart =>
      part.type === "text" && part.synthetic === true
    )!
    // The park replays frame zero and one; each frame, call and classify call counts once.
    expect(summary.text).toMatch(/^2 frames · 4 calls · 1 classify · Jev \d+ calls · \d+ ms · \$0\.0000$/)
    const final = (await get(`/session/${session.id}`)) as Protocol.Session
    expect(final.tokens.input).toBeGreaterThan(0)
    expect(final.cost).toBe(0)
    // The home list carries the dot too.
    const home = (await get("/api/session?limit=5000&order=desc")) as { data: Array<Protocol.SessionV2> }
    expect(home.data.find((item) => item.id === session.id)!.title.startsWith("🟢 ")).toBe(true)
    // Every decision was recorded: frame zero's settle, the park, and frame
    // one's settle; the replayed frame zero was not judged again.
    const listRecords = () =>
      Effect.runPromise(
        Effect.flatMap(Store.Store, (store) => store.listHealth(session.id)).pipe(
          Effect.provide(Store.layerSqlite(`${served.directory}/.smithers/opencode.sqlite`))
        )
      )
    // Four evaluations: frame zero's settle, the park, the answer that cleared
    // it, and frame one's settle. The replayed frame zero was not judged
    // again, and the turn's final color was the rule re-read over its own last
    // facts, not a fifth call.
    await until(async () => (await listRecords()).length === 4)
    const records = await listRecords()
    expect(records.map((record) => record.frame)).toEqual([1, 2, 2, 2])
    expect(records.map((record) => record.state.parked)).toEqual(["none", "permission", "none", "none"])
    expect(records.map((record) => record.color)).toContain("red")
    expect(records.every((record) => record.type === "flows.opencode.health.v1" && record.answers !== undefined)).toBe(
      true
    )
    await reader.cancel()
  })
})
