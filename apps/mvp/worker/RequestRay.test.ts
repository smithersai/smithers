import { Effect } from "effect"
import { HttpEffect, HttpServerResponse } from "effect/http"
import { expect, test } from "vitest"
import { RAY_HEADER, rayOf } from "../src/requestRay.ts"
import { withRequestRay } from "./RequestRay.ts"

const ray = "0123456789abcdef-SJC"

test("API errors return only a valid incoming Cloudflare ray; success representations stay unchanged", async () => {
  for (const status of [200, 204, 400, 403, 429, 503]) {
    for (const incoming of [undefined, ray, "private-person-token-body", "bad\nheader"]) {
      expect(rayOf(incoming)).toBe(incoming === ray ? ray : undefined)
      const headers: Record<string, string> = incoming === undefined || incoming.includes("\n") ? {} : { "cf-ray": incoming }
      const handler = HttpEffect.toWebHandler(withRequestRay(Effect.succeed(HttpServerResponse.empty({ status }))))
      const response = await handler(new Request("http://chat.test/api/test", { headers }))
      expect(response.status).toBe(status)
      expect(response.headers.get(RAY_HEADER)).toBe(status >= 400 && incoming === ray ? ray : null)
    }
  }
})


test("non-API errors and effects outside a request do not gain a response header", async () => {
  const effect = withRequestRay(Effect.succeed(HttpServerResponse.empty({ status: 404 })))
  const response = await Effect.runPromise(effect)
  expect(response.headers[RAY_HEADER]).toBeUndefined()
  const handler = HttpEffect.toWebHandler(effect)
  for (const path of ["/missing", "/api", "/api-other/missing"]) {
    const response = await handler(new Request(`http://chat.test${path}`, { headers: { "cf-ray": ray } }))
    expect(response.status).toBe(404)
    expect(response.headers.get(RAY_HEADER)).toBeNull()
  }
})
