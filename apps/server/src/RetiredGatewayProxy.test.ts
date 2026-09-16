import { describe, expect, test } from "bun:test"
import worker from "./index"
import { memoryDurableObjects } from "./memoryDurableObjects"

describe("retired deployment-identity gateway proxy", () => {
  for (const path of ["/rpc", "/projections", "/sync", "/health"]) {
    for (const upgrade of [false, true]) {
      for (const credential of ["bearer", "placeholder"]) {
        for (const caller of ["anonymous", "expired", "alice", "bob"]) {
          test(`${path} upgrade=${upgrade} ${credential} caller=${caller} never forwards`, async () => {
            const calls: string[] = []
            const original = globalThis.fetch
            globalThis.fetch = (async (input: RequestInfo | URL) => {
              const url = input instanceof Request ? input.url : String(input)
              calls.push(url)
              return new Response("{}", { status: 200 })
            }) as typeof fetch
            try {
              // Leftover deployment configuration must not reactivate the
              // removed path, including when the caller has a user cookie.
              const env = {
                ...memoryDurableObjects(),
                ASSETS: { fetch: async () => new Response("SPA") },
                IDENTITY_UPSTREAM_URL: "https://identity.test",
                IDENTITY_SERVICE_TOKEN: "synthetic-identity-secret",
                GATEWAY_UPSTREAM_URL: "https://gateway.test",
                ...(credential === "bearer"
                  ? { GATEWAY_AUTH_TOKEN: "synthetic-deployment-secret" }
                  : {
                    GATEWAY_SESSION_USER_ID: "deployment-user",
                    GATEWAY_SESSION_USER_ROLE: "admin",
                    GATEWAY_SESSION_USER_SCOPES: "*"
                  })
              }
              const headers = new Headers({ "x-user-id": "deployment-user", authorization: "Bearer forged" })
              if (caller !== "anonymous") headers.set("cookie", `smithers-session=${caller}`)
              if (upgrade) headers.set("upgrade", "websocket")
              const response = await worker.fetch(
                new Request(`https://app.test${path}`, {
                  method: upgrade ? "GET" : "POST",
                  headers,
                  ...(upgrade ? {} : { body: "{}" })
                }),
                env
              )
              expect(response.status).toBe(410)
              const body = await response.text()
              expect(body).toContain("removed")
              expect(body).toContain("/api/workflow/rpc")
              expect(body).not.toContain("synthetic-deployment-secret")
              expect(calls).toEqual([])
            } finally {
              globalThis.fetch = original
            }
          })
        }
      }
    }
  }
})

/*
 * The former Mintlify site published its API reference under the same /rpc
 * prefix the raw gateway used, and the site build's _redirects sends each of
 * those pages to the current reference. The Worker runs first for every path,
 * so the boundary is the method: a GET or HEAD navigation keeps the redirect
 * the site declares for it; a POST, any upgrade, and a path the site never
 * redirected are the tombstone. The assets binding is asked only for a
 * navigation, and the upstream is never asked at all.
 */
describe("legacy documentation aliases under a retired prefix", () => {
  const DOCS = "https://app.test/docs/reference/http-api/"
  const html = { "content-type": "text/html; charset=utf-8" }
  const bindings = (answer: "redirect" | "page" | "missing") => {
    const asked: Array<string> = []
    const env = {
      ...memoryDurableObjects(),
      GATEWAY_UPSTREAM_URL: "https://gateway.test",
      GATEWAY_AUTH_TOKEN: "synthetic-deployment-secret",
      ASSETS: {
        fetch: async (request: Request) => {
          asked.push(`${request.method} ${new URL(request.url).pathname}`)
          if (answer === "redirect") return Response.redirect(DOCS, 301)
          return new Response("<html><body>a page</body></html>", { status: answer === "page" ? 200 : 404, headers: html })
        }
      }
    }
    return { env, asked }
  }
  const request = (path: string, method: string, upgrade: boolean) =>
    new Request(`https://app.test${path}`, {
      method,
      headers: upgrade ? { upgrade: "websocket" } : {},
      ...(method === "GET" || method === "HEAD" ? {} : { body: "{}" })
    })

  for (const path of ["/rpc/list-runs", "/rpc/list-runs/", "/rpc", "/projections/x", "/sync", "/health"]) {
    for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"]) {
      for (const upgrade of [false, true]) {
        for (const answer of ["redirect", "page", "missing"] as const) {
          const navigation = (method === "GET" || method === "HEAD") && !upgrade
          const redirected = navigation && answer === "redirect"
          test(`${method} ${path} upgrade=${upgrade} assets=${answer} -> ${redirected ? "the site's redirect" : "410"}`, async () => {
            const calls: Array<string> = []
            const original = globalThis.fetch
            globalThis.fetch = (async (input: RequestInfo | URL) => {
              calls.push(input instanceof Request ? input.url : String(input))
              return new Response("{}", { status: 200 })
            }) as typeof fetch
            try {
              const { env, asked } = bindings(answer)
              const response = await worker.fetch(request(path, method, upgrade), env)
              if (redirected) {
                expect([response.status, response.headers.get("location")]).toEqual([301, DOCS])
              } else {
                expect(response.status).toBe(410)
                expect(await response.text()).toContain("/api/workflow/rpc")
              }
              expect(asked).toEqual(navigation ? [`${method} ${path}`] : [])
              expect(calls).toEqual([])
            } finally {
              globalThis.fetch = original
            }
          })
        }
      }
    }
  }
})
