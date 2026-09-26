/** Local network boundary for monitor demonstrations; no live credentials or paid requests. */
import { once } from "node:events"
import { createServer } from "node:http"
export async function providerFixture({ judge = false } = {}) {
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}")
    if (body.questions) {
      const passing = new Set(["on_target", "complete", "notable"])
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify({
        answers: Object.fromEntries(
          Object.entries(body.questions).map(([id, q]) => [
            id,
            q.type === "boolean"
              ? { type: "boolean", probability: passing.has(id) ? 0.99 : 0.01 }
              : q.type === "choice"
              ? { type: "choice", choice: q.options?.[0] ?? Object.keys(q.criteria ?? {})[0] ?? "" }
              : { type: "score", score: 0 }
          ])
        )
      }))
    } else {
      response.setHeader("Content-Type", "text/event-stream")
      const content = JSON.stringify(body.messages).includes("You estimate how long")
        ? JSON.stringify({ minutes: 0.1, tokens: 800, low_minutes: 0.05, high_minutes: 0.3 })
        : "Addition checks passed."
      for (const [delta, finish] of [[{ role: "assistant", content }, null], [{}, "stop"]]) {
        response.write(
          `data: ${
            JSON.stringify({
              id: "docs",
              object: "chat.completion.chunk",
              created: 0,
              model: "fixture",
              choices: [{ index: 0, delta, finish_reason: finish }]
            })
          }\n\n`
        )
      }
      response.end("data: [DONE]\n\n")
    }
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const url = `http://127.0.0.1:${server.address().port}`
  return {
    env: {
      OPENAI_API_KEY: "docs-fixture",
      SMITHERS_OPENAI_COMPATIBLE_BASE_URL: url,
      ...(judge ? { AI_GATEWAY_API_KEY: "docs-fixture", SMITHERS_EVALUATOR_BASE_URL: url } : {})
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(resolve)
      })
  }
}
