import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { afterAll, beforeAll, expect, test } from "vitest"
import { ColdReads, coldReadOf, coldReadsFor, heldFetch } from "./coldReads"

test("only first-paint, role and the three issue shapes are held", () => {
  for (const read of ["first-paint", "role"] as const) {
    expect(coldReadOf(new URL(`http://localhost/api/repos/acme/app/${read}?q=private`))).toBe(read)
  }
  for (const read of ["items", "item-summaries", "comments"] as const) {
    expect(coldReadOf(new Request(`http://localhost/api/shapes/${read}?live=true`))).toBe(read)
  }
  for (const path of ["/api/repos/acme/app/issues", "/api/repos/acme/app/role/extra", "/api/shapes/messages", "/role", "/api/auth/session"]) {
    expect(coldReadOf(path)).toBeUndefined()
  }
})

test("release admits all waiting callers, stays released and leaves independent holds closed", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const holds = yield* ColdReads.make(["role", "items"])
    const one = yield* Effect.forkChild(holds.wait("role"))
    const two = yield* Effect.forkChild(holds.wait("role"))
    const itemDone = yield* Deferred.make<void>()
    const item = yield* Effect.forkChild(holds.wait("items").pipe(Effect.andThen(Deferred.succeed(itemDone, undefined))))
    yield* holds.entered("role")
    yield* holds.entered("items")
    yield* holds.release("role")
    yield* Fiber.join(one)
    yield* Fiber.join(two)
    yield* holds.wait("role")
    expect(yield* Deferred.isDone(itemDone)).toBe(false)
    yield* holds.release("items")
    yield* holds.release("items")
    yield* Fiber.join(item)
    yield* holds.wait("comments")
    yield* holds.entered("comments")
    yield* holds.release("comments")
    expect(yield* holds.expired).toEqual([])
  })))
})

test("an abandoned hold expires without a wall-clock sleep", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const holds = yield* ColdReads.make(["role"], "30 seconds")
    const done = yield* Deferred.make<void>()
    const waiting = yield* Effect.forkChild(holds.wait("role").pipe(Effect.andThen(Deferred.succeed(done, undefined))))
    yield* holds.entered("role")
    yield* TestClock.adjust("29 seconds")
    expect(yield* Deferred.isDone(done)).toBe(false)
    yield* TestClock.adjust("1 second")
    yield* Fiber.join(waiting)
    expect(yield* Deferred.isDone(done)).toBe(true)
    expect(yield* holds.expired).toEqual(["role"])
  })).pipe(Effect.provide(TestClock.layer())))
})

let server: Server
let origin: string
const received: string[] = []
beforeAll(async () => {
  server = createServer((request, response) => {
    received.push(`${request.method} ${request.url}`)
    response.writeHead(204).end()
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))

test("injected fetch keeps real HTTP, cancellation, writes and per-page switch identity", async () => {
  const target = { coldReadHolds: ["role", "items"] as const }
  const controls = coldReadsFor(target)
  expect(coldReadsFor(target)).toBe(controls)
  expect(controls.expired()).toEqual([])
  const request = heldFetch(fetch, controls)
  const controller = new AbortController()
  const roleUrl = `${origin}/api/repos/acme/app/role`
  const pending = request(new Request(roleUrl, { signal: controller.signal }))
  const cancelled = expect(pending).rejects.toThrow()
  await controls.entered("role")
  expect(received).not.toContain("GET /api/repos/acme/app/role")
  controller.abort()
  await cancelled
  // RequestInit's signal is respected too; one cancelled caller must not release another.
  const secondController = new AbortController()
  const second = request(roleUrl, { signal: secondController.signal })
  const secondCancelled = expect(second).rejects.toThrow()
  secondController.abort()
  await secondCancelled
  expect((await request(roleUrl, { method: "POST" })).status).toBe(204)
  expect((await request(`${origin}/api/repos/acme/app/issues`)).status).toBe(204)
  const released = request(roleUrl)
  controls.release("role")
  expect((await released).status).toBe(204)
  expect(received).toContain("GET /api/repos/acme/app/role")
  const item = request(`${origin}/api/shapes/items?live=true`)
  await controls.entered("items")
  expect(received).not.toContain("GET /api/shapes/items?live=true")
  controls.release("items")
  expect((await item).status).toBe(204)
  expect(controls.expired()).toEqual([])
  // A healthy page has no held reads at all.
  expect((await heldFetch(fetch, coldReadsFor({}))(`${origin}/api/shapes/comments`)).status).toBe(204)
})
