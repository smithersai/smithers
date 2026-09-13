import { timingSafeEqual } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { TUTORIAL_PROXY_TOKEN_HEADER, tutorialProviderDestinations } from "@smthrs/rpc/TutorialProviderProxy"

/** Fixed subscription egress for the authenticated Cloudflare provider proxy. */
export async function providerRelay(request: IncomingMessage, response: ServerResponse, token: string, path: string, transport: typeof fetch = fetch): Promise<void> {
  const send = (status: number, message: string) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
    response.end(JSON.stringify({ message }))
  }
  const supplied = request.headers[TUTORIAL_PROXY_TOKEN_HEADER]
  const actual = Buffer.from(typeof supplied === "string" ? supplied : ""), expected = Buffer.from(token)
  if (!expected.length || actual.length !== expected.length || !timingSafeEqual(actual, expected)) { send(401, "Service authentication required"); return }
  const destination = path === "/provider/chatgpt" ? "chatgpt" : path === "/provider/refresh" ? "refresh" : undefined
  if (!destination || new URL(request.url ?? "/", "http://internal").search) { send(404, "Unknown subscription route"); return }
  if (request.method !== "POST") { send(405, "Unsupported subscription method"); return }
  const abort = new AbortController()
  const deadline = setTimeout(() => abort.abort(), 120_000)
  const closed = () => { if (!response.writableFinished) abort.abort() }
  response.once("close", closed)
  try {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > 1024 * 1024) { send(413, "Provider request body is too large"); return }
      chunks.push(Buffer.from(chunk))
    }
    const headers = new Headers()
    for (const name of ["authorization", "chatgpt-account-id", "content-type", "accept", "openai-beta", "originator", "user-agent"]) {
      const value = request.headers[name]
      if (typeof value === "string") headers.set(name, value)
    }
    const upstream = await transport(tutorialProviderDestinations[destination], {
      method: "POST", headers, body: Buffer.concat(chunks), redirect: "manual", signal: abort.signal,
    })
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel()
      send(502, "The subscription provider returned an unexpected redirect"); return
    }
    response.statusCode = upstream.status
    response.setHeader("cache-control", "no-store")
    for (const name of ["content-type", "retry-after", "retry-after-ms", "x-request-id", "request-id"]) {
      const value = upstream.headers.get(name)
      if (value !== null) response.setHeader(name, value)
    }
    response.flushHeaders()
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]), response, { signal: abort.signal })
    else response.end()
  } catch {
    if (!response.headersSent && !response.destroyed) send(502, "The subscription provider could not be reached")
    else response.destroy()
  } finally {
    clearTimeout(deadline)
    response.off("close", closed)
  }
}
