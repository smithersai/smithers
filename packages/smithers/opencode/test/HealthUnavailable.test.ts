import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as Health from "../src/Health.ts"
import * as Protocol from "../src/Protocol.ts"
import * as Store from "../src/Store.ts"
import { serve, type Served, until } from "./Harness.ts"

/**
 * The server with no gateway key: the evaluator is the one
 * `Health.evaluatorLayer` builds over an environment without
 * `AI_GATEWAY_API_KEY`, which is what a host runs with on day one.
 */
let served: Served
beforeAll(() => {
  served = serve({ evaluator: Health.evaluatorLayer({}) })
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

describe("Health without a gateway key", () => {
  it("emits one gray card that names the way out, one red card on the park, one gray card after, and no more", async () => {
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
    await until(async () => seen.some((event) => event.type === "permission.asked"))
    const asked = seen.find((event) => event.type === "permission.asked")!
      .properties as unknown as Protocol.PermissionRequest
    await until(async () => ((await get(`/session/${session.id}`)) as Protocol.Session).title.startsWith("🔴 "))
    const replied = await post(`/session/${session.id}/permissions/${asked.id}`, `{"response":"once"}`)
    expect(replied.status).toBe(200)
    await until(async () => seen.some((event) => event.type === "session.idle"))
    // The last decision may land just after the idle. The turn itself ends
    // green: it resolved, and a resolved turn is green on a fact that needs
    // no answers, which is the only color a run with no gateway key ever
    // earns.
    await until(async () => ((await get(`/session/${session.id}`)) as Protocol.Session).title.startsWith("🟢 "))

    const streamed = seen
      .filter((event) => event.type === "message.part.updated")
      .map((event) => event.properties["part"] as Protocol.Part)
      .filter((part): part is Protocol.ToolPart => part.type === "tool" && part.tool === "health")
      .map((part) => part.state.status === "completed" ? [part.state.input["color"], part.state.title] : [])
    // Frame zero's settle is gray, the park is red, frame one's settle is
    // gray again; the two frames of the resumed run judge the same way and
    // say nothing, because the color did not change.
    expect(streamed).toEqual([
      ["gray", Health.noGatewayKey],
      ["red", "waiting for approval"],
      ["gray", Health.noGatewayKey],
      ["green", Health.answeredReason]
    ])
    const history = (await get(`/session/${session.id}/message?limit=20`)) as Array<Store.MessageWithParts>
    const assistant = history.find((item) => item.info.role === "assistant")!
    const cards = assistant.parts.filter((part): part is Protocol.ToolPart =>
      part.type === "tool" && part.tool === "health"
    )
    expect(cards.map((part) => part.state.status === "completed" && part.state.title)).toEqual([
      Health.noGatewayKey,
      "waiting for approval",
      Health.noGatewayKey,
      Health.answeredReason
    ])
    // The card's body is the failure, and it says the same thing once.
    expect(cards[0]!.state.status === "completed" && cards[0]!.state.output).toBe(`unreachable: ${Health.noGatewayKey}`)
    await reader.cancel()
  })
})
