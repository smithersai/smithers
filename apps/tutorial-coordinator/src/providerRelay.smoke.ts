import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { providerRelay } from "./providerRelay"

let calls = 0
let mode = "ok"
let release: (() => void) | undefined
let cancelled = false
const transport: typeof fetch = async (url, init) => {
  calls++
  assert.ok(["https://chatgpt.com/backend-api/codex/responses", "https://auth.openai.com/oauth/token"].includes(String(url)))
  const headers = new Headers(init?.headers)
  assert.equal(headers.get("authorization"), "Bearer subscription")
  assert.equal(headers.get("x-smithers-proxy-token"), null)
  assert.equal(headers.get("cookie"), null)
  assert.equal(headers.get("x-forwarded-for"), null)
  assert.equal(init?.redirect, "manual")
  assert.equal(Buffer.from(init?.body as Uint8Array).toString(), "{}")
  if (mode === "redirect") return new Response(null, { status: 307, headers: { location: "https://evil.invalid" } })
  if (mode === "stream") return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode("data: first\n\n"))
    release = () => controller.close()
    init?.signal?.addEventListener("abort", () => { cancelled = true; controller.error(new Error("cancelled")) }, { once: true })
  } }), { headers: { "content-type": "text/event-stream" } })
  return new Response("quota", { status: 429, headers: { "retry-after": "30", "set-cookie": "secret=1", authorization: "secret" } })
}
const server = createServer((request, response) => void providerRelay(request, response, "private", new URL(request.url!, "http://internal").pathname, transport))
server.listen(0, "127.0.0.1")
await once(server, "listening")
const address = server.address()
assert.ok(address && typeof address !== "string")
const origin = `http://127.0.0.1:${address.port}`
const headers = { "x-smithers-proxy-token": "private", authorization: "Bearer subscription", cookie: "secret", "x-forwarded-for": "fake" }
try {
  assert.equal((await fetch(`${origin}/provider/chatgpt`, { method: "POST", body: "{}" })).status, 401)
  for (const path of ["/provider/openai", "/provider/https://evil.invalid", "/provider/chatgpt?url=evil"]) {
    assert.equal((await fetch(origin + path, { method: "POST", headers, body: "{}" })).status, 404)
  }
  assert.equal((await fetch(`${origin}/provider/chatgpt`, { headers })).status, 405)
  assert.equal((await fetch(`${origin}/provider/chatgpt`, { method: "POST", headers, body: "x".repeat(1024 * 1024 + 1) })).status, 413)
  assert.equal(calls, 0)
  for (const route of ["chatgpt", "refresh"]) {
    const response = await fetch(`${origin}/provider/${route}`, { method: "POST", headers, body: "{}" })
    assert.equal(response.status, 429)
    assert.equal(response.headers.get("retry-after"), "30")
    assert.equal(response.headers.get("cache-control"), "no-store")
    assert.equal(response.headers.get("set-cookie"), null)
    assert.equal(response.headers.get("authorization"), null)
    await response.text()
  }
  mode = "redirect"
  assert.equal((await fetch(`${origin}/provider/chatgpt`, { method: "POST", headers, body: "{}" })).status, 502)
  mode = "stream"
  const response = await fetch(`${origin}/provider/chatgpt`, { method: "POST", headers, body: "{}" })
  const reader = response.body!.getReader()
  assert.equal(new TextDecoder().decode((await reader.read()).value), "data: first\n\n")
  release!()
  assert.equal((await reader.read()).done, true)
  const abort = new AbortController()
  const interrupted = await fetch(`${origin}/provider/chatgpt`, { method: "POST", headers, body: "{}", signal: abort.signal })
  await interrupted.body!.getReader().read()
  abort.abort()
  for (let n = 0; n < 50 && !cancelled; n++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(cancelled, true)
  console.log("Subscription relay: authentication, fixed routes, header isolation, streaming, redirects, and cancellation pass")
} finally {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}
