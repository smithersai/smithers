import { ShapeProxy } from "@smthrs/effect-electric"
import { Clock, Deferred, Effect, Fiber, Layer, Logger, Option, References } from "effect"
import { FetchHttpClient, HttpServerRequest } from "effect/http"
import { TestClock } from "effect/testing"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import { Sessions } from "./Actor.ts"
import * as DevFaults from "./DevFaults.ts"
import * as TestDatabase from "../db/TestDatabase.ts"
import { signedIn, testFile, uuid } from "./test/harness.ts"
import { stackHarness } from "./stack/test/stack.ts"

const runtime = testFile("dev_faults")
const member = { subject: { kind: "person" as const, id: "local-person" }, role: "member" as const }
const request = (path: string, headers: Record<string, string> = {}, method = "GET") => HttpServerRequest.fromWeb(
  new Request(new URL(path, "http://dev.test"), { method, headers }),
)

test("the injected stack service reaches the real handler: refusal stores nothing, healing commits once", async () => {
  const host = await stackHarness(runtime, {
    sessions: DevFaults.sessions.pipe(Layer.provideMerge(signedIn(member))),
  })
  const body = { op: "commit", opId: uuid(), title: "Upgrade refusal", prompt: "Retain the refused request" }
  const post = (fault: string) => host.fetch("/api/repos/octo/hello/stack", {
    method: "POST", headers: { "content-type": "application/json", [DevFaults.STACK_HEADER]: fault }, body: JSON.stringify(body),
  })
  const refused = await post("refuse")
  expect([refused.status, await refused.json()]).toEqual([403, { code: "forbidden" }])
  expect(host.line("stack.request")).toHaveLength(1)
  expect(host.line("stack.request")[0]!.annotations).toMatchObject({ outcome: "forbidden" })
  const rows = () => runtime.runPromise(Effect.flatMap(TestDatabase.Scratch, (scratch) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT count(*)::int AS count FROM todos`).pipe(Effect.provide(scratch.database))))
  expect(await rows()).toEqual([{ count: 0 }])
  expect((await post("")).status).toBe(202)
  expect((await post("other")).status).toBe(200)
  expect(await rows()).toEqual([{ count: 1 }])
})

test.each([
  ["/api/repos/octo/hello/stack", "GET", { [DevFaults.STACK_HEADER]: "refuse" }],
  ["/api/repos/octo/hello/about", "POST", { [DevFaults.STACK_HEADER]: "refuse" }],
  ["/api/repos/octo/hello/stack", "POST", { [DevFaults.STACK_HEADER]: "other" }],
  ["/api/repos/octo/hello/stack", "POST", {}],
])("the stack fault leaves unrelated requests alone: %s %s %s", async (path, method, headers) => {
  const actor = await Effect.runPromise(Effect.flatMap(Sessions, (sessions) => sessions.resolve).pipe(
    Effect.provide(DevFaults.sessions.pipe(Layer.provideMerge(signedIn(member)))),
    Effect.provideService(HttpServerRequest.HttpServerRequest, request(path, headers, method)),
  ))
  expect(actor).toEqual(Option.some(member))
})

test("the stack fault never signs a signed-out person in", async () => {
  expect(await Effect.runPromise(Effect.flatMap(Sessions, (sessions) => sessions.resolve).pipe(
    Effect.provide(DevFaults.sessions.pipe(Layer.provide(Layer.succeed(Sessions, { resolve: Effect.succeedNone })))),
    Effect.provideService(HttpServerRequest.HttpServerRequest, request("/api/repos/octo/hello/stack", { [DevFaults.STACK_HEADER]: "refuse" }, "POST")),
  ))).toEqual(Option.none())
})

test.each([
  ["/api/shapes/todos?live=true", "todos-live", true],
  ["/api/shapes/todos", "todos-live", false],
  ["/api/shapes/todos?live=false", "todos-live", false],
  ["/api/shapes/todos", "todos", true],
  ["/api/shapes/items?live=true", "issues", true],
  ["/api/shapes/item-summaries", "issues", true],
  ["/api/shapes/todo-requests", "todos", false],
  ["/api/shapes/todos", "issues", false],
  ["/api/shapes/todos", "", false],
  ["/api/shapes/todos", "unknown", false],
  ["/api/shapes/todos", undefined, false],
])("the shape switch holds exactly its selection and healing reaches real Electric: %s %s", async (path, fault, held) => {
  const schema = await runtime.runPromise(Effect.map(TestDatabase.Scratch, (scratch) => scratch.name))
  const url = new URL("/v1/shape", await runtime.runPromise(TestDatabase.electricUrl))
  url.searchParams.set("table", `${schema}.todos`)
  url.searchParams.set("offset", "-1")
  let sent = 0
  const observedFetch: typeof globalThis.fetch = (input, init) => { sent++; return globalThis.fetch(input, init) }
  const read = (headers: Record<string, string> = {}) => Effect.scoped(Effect.gen(function* () {
    const client = yield* ShapeProxy.Upstream
    return (yield* client.get(url.href)).status
  }).pipe(
    Effect.provide(DevFaults.electric),
    Effect.provideService(FetchHttpClient.Fetch, observedFetch),
    Effect.provideService(HttpServerRequest.HttpServerRequest, request(path, headers)),
  ))
  if (held) {
    const entered = Deferred.makeUnsafe<void>()
    const log = Logger.make(() => { Deferred.doneUnsafe(entered, Effect.void) })
    await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* read({ unrelated: "x", [DevFaults.SHAPES_HEADER]: fault! }).pipe(
        Effect.provide(Logger.layer([log], { mergeWithExisting: false })),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
        Effect.forkChild,
      )
      yield* Deferred.await(entered)
      // Another real request completes while this one remains held. No fixed sleep, and the held request sends nothing.
      expect(yield* read()).toBe(200)
      expect(sent).toBe(1)
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* Fiber.interrupt(fiber)
    }))
  } else {
    expect(await Effect.runPromise(read(fault === undefined ? {} : { [DevFaults.SHAPES_HEADER]: fault }))).toBe(200)
  }
  expect(await Effect.runPromise(read({ [DevFaults.SHAPES_HEADER]: "" }))).toBe(200)
})


test("a held shape keeps a clock event pending across wakeups and cancels it with the request", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const real = yield* Clock.Clock
    let active = 0
    let registrations = 0
    const clock: Clock.Clock = {
      ...real,
      sleep: (duration) => Effect.sync(() => { active++; registrations++ }).pipe(
        Effect.andThen(real.sleep(duration)),
        Effect.ensuring(Effect.sync(() => { active-- })),
      ),
    }
    const held = Effect.scoped(Effect.gen(function* () {
      const client = yield* ShapeProxy.Upstream
      return yield* client.get("https://electric.invalid/v1/shape")
    }).pipe(
      Effect.provide(DevFaults.electric),
      Effect.provideService(HttpServerRequest.HttpServerRequest, request("/api/shapes/todos", { [DevFaults.SHAPES_HEADER]: "todos" })),
      Effect.provideService(Clock.Clock, clock),
    ))
    const fiber = yield* Effect.forkChild(held, { startImmediately: true })
    yield* Effect.sync(() => fiber.currentDispatcher.flush())
    expect({ active, registrations }).toEqual({ active: 1, registrations: 1 })
    expect(fiber.pollUnsafe()).toBeUndefined()
    yield* TestClock.adjust("1 hour")
    yield* Effect.sync(() => fiber.currentDispatcher.flush())
    expect({ active, registrations }).toEqual({ active: 1, registrations: 2 })
    expect(fiber.pollUnsafe()).toBeUndefined()
    yield* Fiber.interrupt(fiber)
    expect(active).toBe(0)
  }).pipe(Effect.provide(TestClock.layer())))
})
