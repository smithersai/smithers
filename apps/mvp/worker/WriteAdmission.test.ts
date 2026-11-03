import { Clock, Effect, Option } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import { Sessions } from "./Actor.ts"
import { readBounded } from "./Body.ts"
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
