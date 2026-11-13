import { Deferred, Effect, Exit, Fiber, Option } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { expect, test } from "vitest"
import { Sessions } from "./Actor.ts"
import * as Flows from "./Flows.ts"
import { readBounded } from "./Body.ts"
import { testFile } from "./test/harness.ts"
import { cookie, signInHarness } from "./test/signIn.ts"
import { MAX_TOKEN_LENGTH } from "./RunCredentials.ts"
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

test("100 requests seed maintenance once and answer normally", async () => {
  let starts = 0
  const auth = await signInHarness(runtime, { starter: Flows.FlowStarter.of({
    start: () => Effect.sync(() => void starts++),
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

test("a maintenance seed that fails is tried again by the next request, under the one durable intent, until admitted", async () => {
  let unavailable = true
  const intents: Array<string> = []
  const auth = await signInHarness(runtime, { starter: Flows.FlowStarter.of({
    start: (_flow, request) => Effect.suspend(() => {
      intents.push(request.executionId)
      return unavailable ? Effect.fail(new Flows.StartUnavailable({ errorCode: "test_admission" })) : Effect.void
    }),
  }) })
  const signed = await auth.signInAs()
  expect(signed.response.status).toBe(303)
  const handler = HttpEffect.toWebHandler(auth.signIn.admit(Effect.gen(function* () {
    const actor = yield* (yield* Sessions).resolve
    return HttpServerResponse.empty({ status: Option.isSome(actor) ? 200 : 401 })
  }).pipe(Effect.provide(auth.sessions))).pipe(Effect.provide(auth.services)))
  const write = () => handler(new Request("http://smithers.test/api/write", {
    method: "POST", body: "write", headers: { cookie: cookie(signed.cookies), [DEVICE_PERSON_HEADER]: NO_DEVICE_DATA },
  }))
  // A refused seed never denies the request, and is not remembered as started: the next request seeds again.
  expect((await write()).status).toBe(200)
  expect(intents).toHaveLength(1)
  expect((await write()).status).toBe(200)
  expect(intents).toHaveLength(2)
  // Once the host admits it, no later request seeds.
  unavailable = false
  expect((await write()).status).toBe(200)
  expect(intents).toHaveLength(3)
  const responses = await Promise.all(Array.from({ length: 100 }, write))
  expect(responses.map(response => response.status)).toEqual(Array(100).fill(200))
  expect(intents).toEqual(Array(3).fill("auth:session-maintenance:v1"))
})

test("while one request's seed is in flight no other joins it, and its failure frees the next request to seed", async () => {
  const reached = Effect.runSync(Deferred.make<void>())
  const release = Effect.runSync(Deferred.make<void, Flows.StartUnavailable>())
  let starts = 0
  const auth = await signInHarness(runtime, { starter: Flows.FlowStarter.of({
    start: () => Effect.suspend(() => ++starts === 1
      ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)))
      : Effect.void),
  }) })
  const signed = await auth.signInAs()
  expect(signed.response.status).toBe(303)
  // The test clock holds the seed's own timeout, so only the host's answer ends the attempt in flight.
  const handler = HttpEffect.toWebHandler(auth.signIn.admit(Effect.gen(function* () {
    const actor = yield* (yield* Sessions).resolve
    return HttpServerResponse.empty({ status: Option.isSome(actor) ? 200 : 401 })
  }).pipe(Effect.provide(auth.sessions))).pipe(Effect.provide(auth.services), Effect.provide(TestClock.layer())))
  const write = () => handler(new Request("http://smithers.test/api/write", {
    method: "POST", body: "write", headers: { cookie: cookie(signed.cookies), [DEVICE_PERSON_HEADER]: NO_DEVICE_DATA },
  }))
  const seeding = write()
  await Effect.runPromise(Deferred.await(reached))
  // Requests while the seed is in flight answer without waiting for it, and start no seed of their own.
  const others = await Promise.all(Array.from({ length: 20 }, write))
  expect(others.map(response => response.status)).toEqual(Array(20).fill(200))
  expect(starts).toBe(1)
  await Effect.runPromise(Deferred.fail(release, new Flows.StartUnavailable({ errorCode: "test_admission" })))
  expect((await seeding).status).toBe(200)
  // The failed attempt is forgotten: the next request seeds again, and that one is admitted.
  expect((await write()).status).toBe(200)
  expect(starts).toBe(2)
  expect((await write()).status).toBe(200)
  expect(starts).toBe(2)
})

test.each(["timeout", "interrupted"] as const)("a maintenance seed that is %s leaves a later request able to admit it", async outcome => {
  const reached = Effect.runSync(Deferred.make<void>())
  let starts = 0
  const intents: Array<string> = []
  const auth = await signInHarness(runtime, { starter: Flows.FlowStarter.of({
    start: (_flow, request) => Effect.suspend(() => {
      starts++
      intents.push(request.executionId)
      return starts === 1 ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never)) : Effect.void
    }),
  }) })
  const signed = await auth.signInAs()
  expect(signed.response.status).toBe(303)
  const write = () => auth.signIn.admit(Effect.gen(function* () {
    const actor = yield* (yield* Sessions).resolve
    return HttpServerResponse.empty({ status: Option.isSome(actor) ? 200 : 401 })
  }).pipe(Effect.provide(auth.sessions))).pipe(
    Effect.provide(auth.services),
    Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(new Request("http://smithers.test/api/write", {
      method: "POST", body: "write", headers: { cookie: cookie(signed.cookies), [DEVICE_PERSON_HEADER]: NO_DEVICE_DATA },
    }))),
  )
  await Effect.runPromise(Effect.gen(function* () {
    const seeding = yield* Effect.forkChild(write())
    yield* Deferred.await(reached)
    if (outcome === "timeout") {
      yield* TestClock.adjust("1 second")
      expect((yield* Fiber.join(seeding)).status).toBe(200)
    } else {
      yield* Fiber.interrupt(seeding)
      expect(Exit.isFailure(yield* Fiber.await(seeding))).toBe(true)
    }
    expect((yield* write()).status).toBe(200)
    expect((yield* write()).status).toBe(200)
    expect(intents).toEqual(Array(2).fill("auth:session-maintenance:v1"))
  }).pipe(Effect.provide(TestClock.layer())))
})

test("a credential that doesn't read beside the cookie is nobody at the shared boundary, and the cookie isn't read for it", async () => {
  const auth = await signInHarness(runtime)
  const signed = await auth.signInAs()
  expect(signed.response.status).toBe(303)
  // A stale role: reading the cookie would start a role check.
  await sql("UPDATE sessions SET role_checked_at = now() - interval '61 minutes', role_verified_at = now() - interval '61 minutes'")
  const handler = HttpEffect.toWebHandler(auth.signIn.admit(Effect.gen(function* () {
    const actor = yield* (yield* Sessions).resolve
    return HttpServerResponse.empty({ status: Option.isSome(actor) ? 200 : 401 })
  }).pipe(Effect.provide(auth.sessions))).pipe(Effect.provide(auth.services)))
  const write = (authorization?: string) => handler(new Request("http://smithers.test/api/write", {
    method: "POST", body: "write", headers: {
      cookie: cookie(signed.cookies), [DEVICE_PERSON_HEADER]: NO_DEVICE_DATA, ...(authorization === undefined ? {} : { authorization }),
    },
  }))
  for (const authorization of [`Bearer ${"a".repeat(MAX_TOKEN_LENGTH + 1)}`, "bearer forged", "Basic forged", "Bearer"]) {
    expect((await write(authorization)).status, authorization.slice(0, 16)).toBe(401)
  }
  expect(auth.roleChecks).toHaveLength(0)
  // The cookie alone starts its stale role check and waits for fresh authority.
  expect((await write()).status).toBe(503)
  expect(auth.roleChecks).toHaveLength(1)
  await sql("UPDATE sessions SET role_checked_at = now(), role_verified_at = now()")
  expect((await write()).status).toBe(200)
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
