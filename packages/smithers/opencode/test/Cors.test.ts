import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { describe, expect, it } from "vitest"
import * as Cors from "../src/Cors.ts"

const served = () =>
  HttpRouter.toWebHandler(
    Layer.mergeAll(
      HttpRouter.add("GET", "/ok", HttpServerResponse.text("ok")),
      HttpRouter.add("GET", "/boom", Effect.fail(new Error("boom"))),
      Cors.layer(["https://example.test"])
    ),
    { disableLogger: true }
  )

describe("Cors", () => {
  it("allows the OpenCode app and extras, and no loopback page nobody named", () => {
    expect(Cors.allows("https://app.opencode.ai")).toBe(true)
    expect(Cors.allows("https://dev.opencode.ai")).toBe(true)
    // A page on a loopback port is a page the operator never chose; a local
    // build of the app names itself with `--cors` (`Security.test.ts`).
    expect(Cors.allows("http://localhost:5173")).toBe(false)
    expect(Cors.allows("http://127.0.0.1:3000")).toBe(false)
    expect(Cors.allows("http://localhost:5173", [Cors.loopbackExample])).toBe(true)
    expect(Cors.allows("https://evil.example")).toBe(false)
    expect(Cors.allows("https://opencode.ai.evil.example")).toBe(false)
    expect(Cors.allows(undefined)).toBe(false)
    expect(Cors.allows("https://example.test", ["https://example.test"])).toBe(true)
  })

  it("answers a preflight with the headers OpenCode 1.18.31 answers", async () => {
    const { dispose, handler } = served()
    try {
      const response = await handler(
        new Request("http://test/ok", {
          method: "OPTIONS",
          headers: {
            origin: "https://app.opencode.ai",
            "access-control-request-method": "POST",
            "access-control-request-headers": "content-type"
          }
        })
      )
      expect(response.status).toBe(204)
      expect(response.headers.get("access-control-allow-origin")).toBe("https://app.opencode.ai")
      expect(response.headers.get("access-control-allow-methods")).toBe(Cors.allowedMethods)
      expect(response.headers.get("access-control-allow-headers")).toBe("content-type")
      expect(response.headers.get("access-control-max-age")).toBe("86400")
      const bare = await handler(
        new Request("http://test/ok", { method: "OPTIONS", headers: { origin: "https://example.test" } })
      )
      expect(bare.headers.get("access-control-allow-headers")).toBe("authorization, content-type")
    } finally {
      await dispose()
    }
  })

  it("answers a route the server does not mount with a JSON 404 that carries the allow headers", async () => {
    const { dispose, handler } = served()
    try {
      // The app calls v1 routes this server never mounts (revert, fork,
      // share); without the header the browser reports a network error and
      // the app retries, where a 404 it can read is handled.
      const missing = await handler(
        new Request("http://test/session/ses_x/revert", {
          method: "POST",
          headers: { origin: "https://app.opencode.ai" }
        })
      )
      expect(missing.status).toBe(404)
      expect(missing.headers.get("access-control-allow-origin")).toBe("https://app.opencode.ai")
      expect(await missing.json()).toEqual({ name: "NotFoundError", data: { message: "Route not found" } })
      const plain = await handler(new Request("http://test/nope"))
      expect(plain.status).toBe(404)
      expect(plain.headers.get("access-control-allow-origin")).toBeNull()
      expect(await plain.json()).toEqual({ name: "NotFoundError", data: { message: "Route not found" } })
      // A disallowed origin never reaches the router, so it learns nothing
      // about which routes exist either.
      const preflight = await handler(
        new Request("http://test/nope", { method: "OPTIONS", headers: { origin: "https://evil.example" } })
      )
      expect(preflight.status).toBe(403)
      expect(preflight.headers.get("access-control-allow-origin")).toBeNull()
      expect(await preflight.json()).toEqual(Cors.forbiddenOrigin)
      // Any other failure of a route keeps failing past the middleware.
      const boom = await handler(new Request("http://test/boom", { headers: { origin: "https://app.opencode.ai" } }))
      expect(boom.status).toBe(500)
    } finally {
      await dispose()
    }
  })

  it("stamps the allow headers on an ordinary answer and refuses other origins", async () => {
    const { dispose, handler } = served()
    try {
      const allowed = await handler(new Request("http://test/ok", { headers: { origin: "https://example.test" } }))
      expect(allowed.status).toBe(200)
      expect(allowed.headers.get("access-control-allow-origin")).toBe("https://example.test")
      expect(allowed.headers.get("vary")).toBe("Origin")
      const refused = await handler(new Request("http://test/ok", { headers: { origin: "https://evil.example" } }))
      expect(refused.status).toBe(403)
      expect(refused.headers.get("access-control-allow-origin")).toBeNull()
      const preflight = await handler(
        new Request("http://test/ok", { method: "OPTIONS", headers: { origin: "https://evil.example" } })
      )
      expect(preflight.status).toBe(403)
      // No Origin is not a cross-origin decision, so the route answers.
      const none = await handler(new Request("http://test/ok"))
      expect(none.status).toBe(200)
      expect(none.headers.get("access-control-allow-origin")).toBeNull()
    } finally {
      await dispose()
    }
  })
})
