import { Effect } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/http"
import { expect, test } from "vitest"
import * as BodyLimits from "./BodyLimits.ts"
import { afterBody } from "./WriteAdmission.ts"

test.each(["/api/auth/handoff", "/api/auth/handoff?return=%2Fapp"])("%s has the handoff handler's 4 KiB contract", async (path) => {
  expect(await Effect.runPromise(BodyLimits.forRequest(path))).toBe(4096)
})

test("an agent's ask takes the runs routes' 16 KiB; reading one takes no body beyond the aggregate cap", async () => {
  expect(await Effect.runPromise(BodyLimits.forRequest("/api/repos/acme/widgets/asks"))).toBe(16 * 1024)
  expect(await Effect.runPromise(BodyLimits.forRequest("/api/repos/acme/widgets/asks/ask-1"))).toBe(BodyLimits.MAX_BODY_BYTES)
})

test.each(["declared", "streamed"].flatMap((mode) => [4096, 4097].map((size) => [mode, size] as const)))(
  "handoff admission bounds a %s body of %s bytes before resolving authority", async (mode, size) => {
    let admitted = 0
    const handler = HttpEffect.toWebHandler(afterBody(Effect.gen(function* () {
      admitted++
      const request = yield* HttpServerRequest.HttpServerRequest
      return HttpServerResponse.text(yield* request.text.pipe(Effect.orDie))
    })))
    const response = await handler(new Request("http://smithers.test/api/auth/handoff", {
      method: "POST", body: "x".repeat(size),
      ...(mode === "declared" ? { headers: { "content-length": String(size) } } : {}),
    }))
    expect(response.status).toBe(size === 4096 ? 200 : 413)
    expect(admitted).toBe(size === 4096 ? 1 : 0)
    expect(await response.text()).toBe(size === 4096 ? "x".repeat(size) : '{"code":"too_large"}')
  },
)

test("POST /api/hosted-model has a 256-byte body limit", async () => {
  expect(await Effect.runPromise(BodyLimits.forRequest("/api/hosted-model"))).toBe(256)
})

test("a submit to a conversation's messages shard takes 64 KiB; its reads keep the aggregate cap", async () => {
  const base = "/api/conversations/3f2b8c1e-5d4a-4b7e-9c1d-2a6f0e8b7c5d/messages/"
  expect(await Effect.runPromise(BodyLimits.forRequest(base + "submit"))).toBe(65_536)
  expect(await Effect.runPromise(BodyLimits.forRequest(base + "pull?after=0"))).toBe(BodyLimits.MAX_BODY_BYTES)
})
