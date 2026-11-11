import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { forwardThrough, OTHER, OTHER_PLACEHOLDER } from "./fixtures.ts"

let server: Server
let port: number
const seen: Array<{ method: string | undefined; authorization: string | undefined; body: string }> = []

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const chunks: Array<Buffer> = []
    for await (const chunk of request) chunks.push(chunk)
    seen.push({
      method: request.method,
      authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString()
    })
    response.end("ok")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(() => server.close())

// Send through the real HTTP transport, routing only the bound host to the fixture server.
const realFetch: typeof globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  return globalThis.fetch(
    url.hostname === "api.github.com" ? `http://127.0.0.1:${port}${url.pathname}` : url.href,
    init
  )
}

describe("request bodies, with the real fetch", () => {
  test.each(["DELETE", "POST", "PUT", "PATCH", "OPTIONS"])(
    "%s sends a missing, empty or nonempty request body",
    async (method) => {
      const variants: ReadonlyArray<{ body?: string; headers?: Record<string, string> }> = [
        {},
        { headers: { "content-length": "0" } },
        { headers: { "transfer-encoding": "chunked" } },
        { body: "" },
        { body: `body ${OTHER_PLACEHOLDER}` }
      ]
      for (const variant of variants) {
        const before = seen.length
        const { response, body, entries } = await forwardThrough(
          new Request("https://api.github.com/resource", {
            ...variant,
            method,
            headers: { ...variant.headers, authorization: `Bearer ${OTHER_PLACEHOLDER}` }
          }),
          { fetch: realFetch }
        )
        expect([response.status, body]).toEqual([200, "ok"])
        expect(seen).toHaveLength(before + 1)
        expect(seen.at(-1)).toEqual({ method, authorization: `Bearer ${OTHER}`, body: variant.body ?? "" })
        expect(entries).toEqual([{ host: "api.github.com", method, outcome: "forwarded", secrets: ["GH_TOKEN"] }])
      }
    }
  )
})
