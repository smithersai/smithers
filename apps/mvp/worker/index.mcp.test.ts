import { expect, test } from "vitest"
import site from "./index.ts"

type SiteRequest = Parameters<typeof site.fetch>[0]
type BindingFetch = (request: Request) => Promise<Response>

const binding = (fetch: BindingFetch) => ({ fetch }) as unknown as Fetcher
const unexpected = (name: string): Fetcher => binding(async () => {
  throw new Error(`Unexpected request to ${name}`)
})

test.each([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/evmts/voltaire/mcp",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/evmts/voltaire/mcp",
])("GET %s forwards the original request to ChatApi", async (path) => {
  const request = new Request(`https://smithers.test${path}?client=test`)
  const metadata = Response.json({ issuer: "https://smithers.test" })
  const env = {
    ASSETS: unexpected("ASSETS"),
    CHAT_API: binding(async (forwarded) => {
      expect(forwarded).toBe(request)
      return metadata
    }),
  }

  expect(await site.fetch(request as SiteRequest, env)).toBe(metadata)
})

test("repository MCP forwards the POST, query, headers and body to ChatApi", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  const request = new Request("https://smithers.test/evmts/voltaire/mcp?x=1&x=2", {
    method: "POST",
    headers: {
      authorization: `Bearer sma_${"a".repeat(64)}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body,
  })
  const reply = Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } })
  const env = {
    ASSETS: unexpected("ASSETS"),
    CHAT_API: binding(async (forwarded) => {
      expect(forwarded.url).toBe("https://smithers.test/api/repos/evmts/voltaire/mcp?x=1&x=2")
      expect(forwarded.method).toBe("POST")
      expect([...forwarded.headers]).toEqual([...request.headers])
      expect(await forwarded.text()).toBe(body)
      return reply
    }),
  }

  expect(await site.fetch(request as SiteRequest, env)).toBe(reply)
})

test.each(["/app/mcp/authorize", "/app/runs/mcp"])("GET %s serves the app shell", async (path) => {
  const request = new Request(`https://smithers.test${path}`)
  const env = {
    CHAT_API: unexpected("CHAT_API"),
    ASSETS: binding(async (forwarded) => {
      expect(forwarded).toBe(request)
      return new Response("<html>__SMITHERS_ORIGIN__</html>", { headers: { "content-type": "text/html" } })
    }),
  }

  const response = await site.fetch(request as SiteRequest, env)
  expect(response.status).toBe(200)
  expect(await response.text()).toBe("<html>https://smithers.test</html>")
})
