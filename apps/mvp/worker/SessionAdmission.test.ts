import { Effect, Option } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import { Sessions } from "#vibelang/emitted/worker/Actor"
import * as Flows from "#vibelang/emitted/worker/Flows"
import { readBounded } from "#vibelang/emitted/worker/Body"
import { testFile } from "./test/harness.ts"
import { cookie, signInHarness } from "./test/signIn.ts"
import { DEVICE_PERSON_HEADER, NO_DEVICE_DATA } from "../src/features/auth/contract.ts"

const runtime = testFile("session_admission")
const sql = (query: string) => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, client => client.unsafe(query)))

test("the shared cookie guard observes a session end during body upload", async () => {
  const auth = await signInHarness(runtime)
  const signed = await auth.signInAs()
  expect(signed.response.status).toBe(303)
  const handler = HttpEffect.toWebHandler(auth.signIn.admit(Effect.gen(function* () {
    const actor = yield* (yield* Sessions).resolve
    const body = yield* readBounded(yield* HttpServerRequest.HttpServerRequest, 1024).pipe(Effect.orDie)
    return HttpServerResponse.jsonUnsafe({ admitted: Option.isSome(actor), body })
  }).pipe(Effect.provide(auth.sessions))).pipe(Effect.provide(auth.services)))
  const control = await handler(new Request("http://smithers.test/api/write", {
    method: "POST", headers: { cookie: cookie(signed.cookies), [DEVICE_PERSON_HEADER]: NO_DEVICE_DATA }, body: "control",
  }))
  expect(await control.json()).toEqual({ admitted: true, body: "control" })
  await sql("UPDATE sessions SET role_checked_at = now() - interval '61 minutes', role_verified_at = now() - interval '61 minutes'")
  let reading!: () => void
  const read = new Promise<void>(resolve => { reading = resolve })
  let finish!: () => void
  const finished = new Promise<void>(resolve => { finish = resolve })
  let first = true
  const body = new ReadableStream<Uint8Array>({ async pull(controller) {
    if (first) { first = false; controller.enqueue(new TextEncoder().encode("first")); return }
    reading()
    await finished
    controller.enqueue(new TextEncoder().encode("last"))
    controller.close()
  } }, { highWaterMark: 0 })
  const response = handler(new Request("http://smithers.test/api/write", {
    method: "POST", headers: { cookie: cookie(signed.cookies), [DEVICE_PERSON_HEADER]: NO_DEVICE_DATA }, body, duplex: "half",
  } as RequestInit))
  await read
  const checksBeforeEof = auth.roleChecks.length
  try { await sql("UPDATE sessions SET revoked_at = now(), revoked_reason = 'sign_out'") } finally { finish() }
  expect(await (await response).json()).toEqual({ admitted: false, body: "firstlast" })
  expect(checksBeforeEof).toBe(0)
})

test.each([false, true])("100 requests start maintenance once and answer normally (start fails: %s)", async failing => {
  let starts = 0
  const auth = await signInHarness(runtime, { starter: Flows.FlowStarter.of({
    start: () => Effect.suspend(() => {
      starts++
      return failing ? Effect.fail(new Flows.StartUnavailable({ errorCode: "test_admission" })) : Effect.void
    }),
  }) })
  const signed = await auth.signInAs()
  expect(signed.response.status).toBe(303)
  let actions = 0
  const handler = HttpEffect.toWebHandler(auth.signIn.admit(Effect.gen(function* () {
    const actor = yield* (yield* Sessions).resolve
    if (Option.isNone(actor)) return HttpServerResponse.empty({ status: 401 })
    actions++
    return HttpServerResponse.empty({ status: 200 })
  }).pipe(Effect.provide(auth.sessions))).pipe(Effect.provide(auth.services)))
  const responses = await Promise.all(Array.from({ length: 100 }, () => handler(new Request("http://smithers.test/api/write", {
    method: "POST", body: "write", headers: { cookie: cookie(signed.cookies), [DEVICE_PERSON_HEADER]: NO_DEVICE_DATA },
  }))))
  expect(responses.map(response => response.status)).toEqual(Array(100).fill(200))
  expect(actions).toBe(100)
  expect(starts).toBe(1)
})

test("a throttled request reaches neither cookie role work nor its route", async () => {
  const auth = await signInHarness(runtime)
  const signed = await auth.signInAs()
  expect(signed.response.status).toBe(303)
  await sql("UPDATE sessions SET role_checked_at = now() - interval '61 minutes', role_verified_at = now() - interval '61 minutes'")
  let actions = 0
  const handler = HttpEffect.toWebHandler(auth.signIn.admit(Effect.sync(() => {
    actions++
    return HttpServerResponse.empty({ status: 200 })
  }), Effect.succeed(Option.some(HttpServerResponse.empty({ status: 429 })))).pipe(Effect.provide(auth.services)))
  const response = await handler(new Request("http://smithers.test/api/write", {
    method: "POST", body: "write", headers: { cookie: cookie(signed.cookies), [DEVICE_PERSON_HEADER]: NO_DEVICE_DATA },
  }))
  expect([response.status, actions, auth.roleChecks.length]).toEqual([429, 0, 0])
})
