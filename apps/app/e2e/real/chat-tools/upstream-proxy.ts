const upstream = process.env.SMITHERS_REAL_CHAT_UPSTREAM ?? "https://chat.smithers.sh/chat"
const port = Number(process.env.SMITHERS_REAL_CHAT_PROXY_PORT)
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid SMITHERS_REAL_CHAT_PROXY_PORT: ${process.env.SMITHERS_REAL_CHAT_PROXY_PORT}`)
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const incoming = new URL(request.url)
    if (request.method === "GET" && incoming.pathname === "/__harness_ready") {
      return new Response(null, { status: 204 })
    }
    if (request.method !== "POST" || incoming.pathname !== "/chat") {
      return new Response("not found", { status: 404 })
    }
    const headers = new Headers(request.headers)
    headers.delete("host")
    console.error(`[chat-passthrough] forwarding ${request.method} ${incoming.pathname}`)
    const response = await fetch(upstream, {
      method: request.method,
      headers,
      body: request.body
    })
    return new Response(response.body, { status: response.status, headers: response.headers })
  }
})

console.error(`[chat-passthrough] listening on ${server.url.origin}`)
await new Promise<never>(() => {})
