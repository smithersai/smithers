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
