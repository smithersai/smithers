import { afterEach, expect, test } from "bun:test"
import edge from "./edge"

const servers: Array<ReturnType<typeof Bun.serve>> = []
afterEach(() => { for (const server of servers.splice(0)) server.stop(true) })
const backend = (fetch: (request: Request) => Response | Promise<Response>) => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })
  servers.push(server)
  return server.url.origin
}
const assets = { fetch: async () => new Response("missing", { status: 404 }) }

test("every product route reaches the selected shared backend without edge authority", async () => {
  const received: string[] = []
  const origin = backend(request => {
    received.push(new URL(request.url).pathname)
    return Response.json({ source: "shared", path: new URL(request.url).pathname }, { status: 418 })
  })
  const paths = ["bootstrap", "agent/turn", "agent/turn/cancel", "agent/turn/replay", "agent/turn/retire",
    "agent/turn/erase", "model/catalog", "model/credential", "model/credential/receipt", "model/default",
    "model/test", "model/stream", "recommend", "recommend/outcome", "user", "auth/github",
    "auth/github/callback", "auth/logout", "billing/balance", "workflow/rpc", "repos/a/b/workspace", "unknown"]
  for (const path of paths) {
    const response = await edge.fetch(new Request(`https://canary.smithers.sh/api/${path}`), { ASSETS: assets, SMITHERS_BACKEND_ORIGIN: origin })
    expect(response.status).toBe(418)
    expect(await response.json()).toEqual({ source: "shared", path: `/api/${path}` })
  }
  expect(received).toEqual(paths.map(path => `/api/${path}`))
})

test("forwards session, bearer, CSRF, query and body; strips forged proxy authority", async () => {
  let received: { url: string; method: string; headers: Headers; body: string } | undefined
  const origin = backend(async request => {
    received = { url: request.url, method: request.method, headers: request.headers, body: await request.text() }
    return new Response("denied", { status: 403, headers: { "x-request-id": "shared-request" } })
  })
  const response = await edge.fetch(new Request("https://canary.smithers.sh/api/model/credential?one=a%2Fb&one=c", {
    method: "POST", headers: { cookie: "smithers_session=session; smithers_csrf=csrf", authorization: "token account-token",
      "x-csrf-token": "csrf", origin: "https://canary.smithers.sh", "content-type": "application/json",
      "x-user-id": "999", "x-user-login": "admin", "x-smithers-service-token": "forged", "x-forwarded-for": "1.2.3.4" }, body: '{"id":"request"}'
  }), { ASSETS: assets, SMITHERS_BACKEND_ORIGIN: origin })
  expect(received?.url).toBe(`${origin}/api/model/credential?one=a%2Fb&one=c`)
  expect(received?.method).toBe("POST")
  expect(received?.body).toBe('{"id":"request"}')
  expect(received?.headers.get("cookie")).toContain("smithers_session=session")
  expect(received?.headers.get("authorization")).toBe("token account-token")
  expect(received?.headers.get("x-csrf-token")).toBe("csrf")
  expect(received?.headers.get("origin")).toBe("https://canary.smithers.sh")
  for (const key of ["x-user-id", "x-user-login", "x-smithers-service-token", "x-forwarded-for"]) expect(received?.headers.has(key)).toBe(false)
  expect(response.status).toBe(403)
  expect(response.headers.get("x-request-id")).toBe("shared-request")
  expect(await response.text()).toBe("denied")
})

test("OAuth cookies and redirects pass through without following them", async () => {
  let requests = 0
  const origin = backend(() => {
    requests++
    const headers = new Headers({ location: "https://github.com/login/oauth/authorize?state=opaque" })
    headers.append("set-cookie", "smithers_session=example; Path=/; HttpOnly; Secure; SameSite=Lax")
    headers.append("set-cookie", "smithers_csrf=example; Path=/; Secure; SameSite=Strict")
    return new Response(null, { status: 302, headers })
  })
  const response = await edge.fetch(new Request("https://canary.smithers.sh/api/auth/github/callback?code=opaque"), { ASSETS: assets, SMITHERS_BACKEND_ORIGIN: origin })
  expect(requests).toBe(1)
  expect(response.status).toBe(302)
  expect(response.headers.get("location")).toBe("https://github.com/login/oauth/authorize?state=opaque")
  expect(response.headers.getSetCookie()).toHaveLength(2)
})

test("returns an accepted chat frame before the shared stream finishes", async () => {
  let finish!: () => void
  const origin = backend(() => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"type":"accepted"}\n'))
    finish = () => { controller.enqueue(new TextEncoder().encode('{"type":"done"}\n')); controller.close() }
  } }), { headers: { "content-type": "application/x-ndjson", "x-smithers-turn-journal": "1" } }))
  const response = await edge.fetch(new Request("https://canary.smithers.sh/api/agent/turn"), { ASSETS: assets, SMITHERS_BACKEND_ORIGIN: origin })
  const reader = response.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('{"type":"accepted"}\n')
  expect(response.headers.get("x-smithers-turn-journal")).toBe("1")
  finish()
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('{"type":"done"}\n')
  expect((await reader.read()).done).toBe(true)
})

test("missing, invalid or self-referencing backend fails closed without reading assets", async () => {
  let assetReads = 0
  const ASSETS = { fetch: async () => { assetReads++; return new Response("asset") } }
  for (const target of [undefined, "https://user:secret@api.example", "https://api.example/prefix", "https://canary.smithers.sh"]) {
    const response = await edge.fetch(new Request("https://canary.smithers.sh/api/bootstrap"), { ASSETS, SMITHERS_BACKEND_ORIGIN: target })
    expect(response.status).toBe(503)
  }
  expect(assetReads).toBe(0)
})

test("unreachable shared host yields an honest gateway failure", async () => {
  const origin = backend(() => new Response("unused"))
  servers.at(-1)!.stop(true)
  const response = await edge.fetch(new Request("https://canary.smithers.sh/api/bootstrap"), { ASSETS: assets, SMITHERS_BACKEND_ORIGIN: origin })
  expect(response.status).toBe(502)
  expect((await response.json()).code).toBe("upstream_unreachable")
})

test("repository reloads serve the app document with isolation and canary noindex", async () => {
  const seen: string[] = []
  const ASSETS = { fetch: async (request: Request) => {
    const path = new URL(request.url).pathname
    seen.push(path)
    return path === "/smithersai/smithers/" ? new Response('<div id="root"></div>', { headers: { "content-type": "text/html" } }) : new Response("missing", { status: 404 })
  } }
  const response = await edge.fetch(new Request("https://canary.smithers.sh/example/repository"), { ASSETS })
  expect(response.status).toBe(200)
  expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp")
  expect(response.headers.get("x-robots-tag")).toBe("noindex")
  expect(seen).toEqual(["/example/repository", "/smithersai/smithers/"])
})
