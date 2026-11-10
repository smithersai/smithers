import { SharedText } from "@smthrs/sync"
import { Base64 } from "effect/encoding"
import { Clock, ConfigProvider, Effect, Option } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import { Sessions } from "./Actor.ts"
import { readBounded } from "./Body.ts"
import * as Throttle from "./Throttle.ts"
import { afterBody } from "./WriteAdmission.ts"
import { testFile } from "./test/harness.ts"
import { cookie, signInHarness } from "./test/signIn.ts"

const runtime = testFile("write_admission")
const sql = (query: string) => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe(query)))

// This is the dispatch boundary: the handler resolves authority before reading its body, as secrets and personal
// connections do. Real sign-in and Postgres decide the request; the stream handshake controls only delivery.
test.each(["POST", "PUT", "PATCH", "DELETE"])("%s establishes authority only after EOF", async (method) => {
  const auth = await signInHarness(runtime)
  const signed = await auth.signInAs()
  expect(signed.response.status).toBe(303)
  const [person] = await sql("SELECT person_id::text AS id FROM sessions ORDER BY created_at DESC LIMIT 1")
  const headers = { cookie: cookie(signed.cookies), "x-smithers-device-person": String((person as { id: string }).id) }
  const handler = HttpEffect.toWebHandler(afterBody(Effect.gen(function* () {
    const actor = yield* (yield* Sessions).resolve
    const body = yield* readBounded(yield* HttpServerRequest.HttpServerRequest, 1024).pipe(Effect.orDie)
    return HttpServerResponse.jsonUnsafe({ admitted: Option.isSome(actor), body })
  }).pipe(Effect.provide(auth.sessions))))
  let reading!: () => void
  const read = new Promise<void>((resolve) => { reading = resolve })
  let finish!: () => void
  const finished = new Promise<void>((resolve) => { finish = resolve })
  let head = true
  const body = new ReadableStream<Uint8Array>({ async pull(controller) {
    if (head) { head = false; controller.enqueue(new TextEncoder().encode("first")); return }
    reading()
    await finished
    controller.enqueue(new TextEncoder().encode("last"))
    controller.close()
  } }, { highWaterMark: 0 })
  const response = handler(new Request("http://smithers.test/api/write", {
    method, headers, body, duplex: "half",
  } as RequestInit))
  await read
  try { await sql("UPDATE sessions SET revoked_at = now(), revoked_reason = 'sign_out'") } finally { finish() }
  expect(await (await response).json()).toEqual({ admitted: false, body: "firstlast" })
})

test("a body deadline ends a never-ending write before resolving authority", async () => {
  let resolved = 0
  const handler = HttpEffect.toWebHandler(afterBody(Effect.sync(() => {
    resolved++
    return HttpServerResponse.empty({ status: 200 })
  })).pipe(Effect.catchCause((cause) => Effect.succeed(HttpServerResponse.text(String(cause), { status: 500 }))), Effect.updateService(Clock.Clock, (clock) => Object.assign(Object.create(clock), { sleep: () => Effect.void }))))
  const response = await handler(new Request("http://smithers.test/api/write", {
    method: "PUT", body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])) } }), duplex: "half",
  } as RequestInit))
  expect([response.status, await response.text()]).toEqual([408, '{"code":"body_timeout"}'])
  expect(resolved).toBe(0)
})

test("GET does not read a body or wait on the write deadline", async () => {
  const handler = HttpEffect.toWebHandler(afterBody(Effect.succeed(HttpServerResponse.empty({ status: 204 }))))
  expect((await handler(new Request("http://smithers.test/api/read"))).status).toBe(204)
})


test.each(["coedit seed", "issue"])("a valid paced %s upload lasting over ten seconds is admitted", async (kind) => {
  const text = kind === "coedit seed"
    ? JSON.stringify({ scope: { conversation: "home" }, id: crypto.randomUUID(), update: Base64.encode(SharedText.seed("x".repeat(1024 * 1024))), seed: true })
    : JSON.stringify({ writeId: crypto.randomUUID(), op: "issue/create", title: "Slow phone", body: "x".repeat(65_000) })
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  let resolved = 0
  const handler = HttpEffect.toWebHandler(afterBody(Effect.gen(function* () {
    resolved++
    const request = yield* HttpServerRequest.HttpServerRequest
    const body = yield* readBounded(request, 2 * 1024 * 1024).pipe(Effect.orDie)
    return HttpServerResponse.jsonUnsafe({ body })
  })))
  const start = performance.now()
  const response = await handler(new Request(kind === "coedit seed" ? "http://smithers.test/api/texts/file" : "http://smithers.test/api/repos/octo/hello/writes", {
    method: "POST", duplex: "half", body: new ReadableStream<Uint8Array>({ async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 700))
      const end = Math.min(bytes.length, offset + Math.ceil(bytes.length / 16))
      controller.enqueue(bytes.slice(offset, end))
      offset = end
      if (offset === bytes.length) controller.close()
    } }, { highWaterMark: 0 }),
  } as RequestInit))
  expect([response.status, resolved]).toEqual([200, 1])
  expect(await response.json()).toEqual({ body: text })
  expect(performance.now() - start).toBeGreaterThan(10_000)
}, 20_000)


test("a throttled 8 MiB telemetry caller consumes no body", async () => {
  let pulls = 0
  let handled = 0
  const limit = Throttle.make({ shape: { limit: () => Effect.succeed({ success: false }) }, telemetry: { limit: () => Effect.succeed({ success: false }) }, broker: { limit: () => Effect.succeed({ success: false }) } })
  const check = Effect.flatMap(HttpServerRequest.HttpServerRequest, limit)
  const handler = HttpEffect.toWebHandler(afterBody(Effect.sync(() => {
    handled++
    return HttpServerResponse.empty({ status: 204 })
  }), check))
  const response = await handler(new Request("http://smithers.test/api/telemetry/v1/logs", { method: "POST", duplex: "half",
    body: new ReadableStream<Uint8Array>({ pull(controller) {
      pulls++
      controller.enqueue(new Uint8Array(8 * 1024 * 1024))
      controller.close()
    } }, { highWaterMark: 0 }),
  } as RequestInit))
  expect([response.status, pulls, handled]).toEqual([429, 0, 0])
})

test.each([
  ["/api/telemetry/v1/logs", 128 * 1024],
  ["/api/repos/octo/hello/runners/runner", 8 * 1024],
  ["/api/repos/octo/hello/secrets/KEY", 32 * 1024],
  ["/api/questions", 64 * 1024],
] as const)("%s enforces its route size before reading the rest", async (path, limit) => {
  let pulls = 0
  let handled = 0
  const handler = HttpEffect.toWebHandler(afterBody(Effect.sync(() => {
    handled++
    return HttpServerResponse.empty({ status: 204 })
  })))
  const response = await handler(new Request(`http://smithers.test${path}`, { method: path.includes("runners") || path.includes("secrets") ? "PUT" : "POST", duplex: "half",
    body: new ReadableStream<Uint8Array>({ pull(controller) {
      pulls++
      controller.enqueue(new Uint8Array(limit + 1))
      if (pulls === 2) controller.close()
    } }, { highWaterMark: 0 }),
  } as RequestInit))
  expect([response.status, pulls, handled]).toEqual([413, 1, 0])
})



test("model buffering uses the configured byte cap and rejects content-length before pulling", async () => {
  let pulls = 0
  const handler = HttpEffect.toWebHandler(afterBody(Effect.succeed(HttpServerResponse.empty({ status: 204 }))).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ MODEL_MAX_REQUEST_BYTES: "32" })),
  ))
  const accepted = await handler(new Request("http://smithers.test/api/model/chat", { method: "POST", body: new Uint8Array(32) }))
  expect(accepted.status).toBe(204)
  const response = await handler(new Request("http://smithers.test/api/model/chat", { method: "POST", duplex: "half", headers: { "content-length": "33" },
    body: new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(33)); controller.close() } }, { highWaterMark: 0 }),
  } as RequestInit))
  expect([response.status, pulls]).toEqual([413, 0])
})
