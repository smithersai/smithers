import assert from "node:assert/strict"
import { Agent, createServer, request } from "node:http"
import { requestJson } from "../../tutorial-executor/src/requestJson"

const received: { method?: string; body: string; socket: unknown }[] = []
const server = createServer(async (incoming, response) => {
  let body = ""
  for await (const chunk of incoming) body += chunk
  received.push({ method: incoming.method, body, socket: incoming.socket })
  if (incoming.url === "/invalid") { response.writeHead(502); response.end("Bad Gateway: private upstream detail"); return }
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify({ ok: true }))
})
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
const port = (server.address() as { port: number }).port
const agent = new Agent({ keepAlive: true, maxSockets: 1 })
const options = { hostname: "127.0.0.1", port, path: "/pods/expired", method: "DELETE", agent, timeout: 1000 }
try {
  // The second DELETE used to receive HTTP 400 after the first body's bytes
  // were treated as an extra request. Exercise the real Node socket parser.
  for (let i = 0; i < 3; i++) assert.equal((await requestJson(options, { gracePeriodSeconds: 0, marker: "é" }, request)).status, 200)
  assert.equal(received.length, 3)
  for (const item of received) {
    assert.equal(item.method, "DELETE")
    assert.deepEqual(JSON.parse(item.body), { gracePeriodSeconds: 0, marker: "é" })
    assert.equal(item.socket, received[0]!.socket)
  }
  await assert.rejects(requestJson({ ...options, path: "/invalid", method: "GET" }, undefined, request), {
    message: "Tutorial workspace service returned an invalid response (HTTP 502). Try again shortly."
  })
  console.log("Kubernetes HTTP passed: DELETE bodies survive connection reuse; invalid replies report status without leaking response bodies")
} finally {
  agent.destroy()
  await new Promise<void>(resolve => server.close(() => resolve()))
}
