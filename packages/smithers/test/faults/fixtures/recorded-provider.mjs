// Loaded only by the real-binary recovery tests, including detached children.
// No real provider request is permitted, and no credential is recorded.
import { Agent, MockAgent } from "@effect/platform-node/Undici"
import { deepStrictEqual } from "node:assert"
import { appendFileSync, readFileSync } from "node:fs"

const directory = process.env.SMITHERS_TEST_RECORDING
if (!directory) throw new Error("Missing recovery recording directory")
const record = (entry) => appendFileSync(`${directory}/processes.jsonl`, `${JSON.stringify(entry)}\n`)
record({ pid: process.pid, ppid: process.ppid, verb: process.argv[2], event: "start" })
process.on("exit", (code) => record({ pid: process.pid, event: "exit", code }))

// Keep the mock's internal agent on the original dispatch implementation.
// Production creates private Agents, so replacing the global dispatcher alone
// would not intercept its requests.
const underlying = new Agent()
underlying.dispatch = underlying.dispatch.bind(underlying)
const mock = new MockAgent({ agent: underlying })
mock.disableNetConnect()
mock.get("https://api.openai.com").intercept({ path: "/v1/responses", method: "POST" }).reply(() => {
  appendFileSync(`${directory}/requests.jsonl`, `${JSON.stringify({ pid: process.pid })}\n`)
  const cell = `\`\`\`cell\n${readFileSync(`${directory}/cell.txt`, "utf8")}\n\`\`\``
  const events = [
    { type: "response.output_text.delta", item_id: "msg_1", delta: cell },
    { type: "response.output_text.done", item_id: "msg_1" },
    { type: "response.completed", response: { id: "resp_1" } }
  ]
  return {
    statusCode: 200,
    data: events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    responseOptions: { headers: { "content-type": "text/event-stream" } }
  }
})
mock.get("https://ai-gateway.vercel.sh").intercept({ path: "/v4/ai/evaluation-model", method: "POST" }).reply(({ body }) => {
  const request = JSON.parse(typeof body === "string" ? body : Buffer.from(body).toString("utf8"))
  const questions = Object.fromEntries(
    Object.entries(request.questions).map(([id, question]) => [id, question.type])
  )
  deepStrictEqual(questions, { complete: "boolean", overclaims: "boolean", invented: "boolean" })
  appendFileSync(`${directory}/evaluations.jsonl`, `${JSON.stringify({ pid: process.pid, questions })}\n`)
  return {
    statusCode: 200,
    data: JSON.stringify({
      answers: {
        complete: { type: "boolean", probability: 0.99 },
        overclaims: { type: "boolean", probability: 0.01 },
        invented: { type: "boolean", probability: 0.01 }
      }
    }),
    responseOptions: { headers: { "content-type": "application/json" } }
  }
})
Agent.prototype.dispatch = function(options, handler) {
  return mock.dispatch(options, handler)
}
globalThis.fetch = async () => { throw new Error("Unexpected fetch in recorded CLI recovery test") }
