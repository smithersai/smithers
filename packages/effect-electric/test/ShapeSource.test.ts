import { Effect, Exit, Fiber, Schedule, Stream, SubscriptionRef } from "effect"
import { FetchHttpClient } from "effect/http"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { ShapeSource } from "../src/index.ts"

// The shape source against a local HTTP server that answers every request with its own URL, as Electric would answer
// a shape request: real sockets, no Electric needed.

let origin = ""
let answered = 0
// A request to /slow waits at the server, `slowWaiting`, until `answerSlow` is called.
let slowWaiting = false
let answerSlow = () => {}
let close = () => Promise.resolve()
const receivedRequests = new Set<string>()
const closedRequests = new Set<string>()
const heldResponses = new Map<string, () => void>()
beforeAll(async () => {
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/body-held") || request.url?.startsWith("/headers-held")) {
      const path = request.url
      receivedRequests.add(path)
      heldResponses.set(path, () => response.destroy())
      response.on("close", () => {
        closedRequests.add(path)
        heldResponses.delete(path)
      })
      if (path.startsWith("/body-held")) {
        response.writeHead(200, { "content-type": "application/json" })
        response.flushHeaders()
        response.write("[")
      }
      return
    }
    // A body that breaks off: the connection drops after its first bytes.
    if (request.url?.startsWith("/broken") === true) {
      response.writeHead(200, { "content-type": "application/json", "content-length": "100" })
      response.write("[{", () => response.destroy())
      return
    }
    if (request.url?.startsWith("/slow") === true) {
      slowWaiting = true
      answerSlow = () => response.end("[]", () => (answered += 1))
      return
    }
    response.writeHead(200, { "content-type": "application/json", "electric-offset": "1_0" })
    response.end(JSON.stringify({ url: request.url }), () => {
      answered += 1
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = () => new Promise((resolve) => server.close(() => resolve()))
})
afterAll(() => close())

const request = (path: string) =>
  Effect.gen(function*() {
    const source = yield* ShapeSource.ShapeSource
    return yield* source.request(`${origin}${path}`, {})
  })

const body = (response: Response) => Effect.promise(() => response.text())

describe("the real source", () => {
  test("a caller abort after headers cancels the response body and closes the server connection", async () => {
    const path = `/body-held?request=${crypto.randomUUID()}`
    const caller = new AbortController()
    const response = await Effect.runPromise(
      ShapeSource.fetchSource.request(`${origin}${path}`, { signal: caller.signal })
    )
    const reading = response.text().then(() => "completed", (error: unknown) => (error as Error).name)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      caller.abort()
      const deadline = new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("body still open"), 1_000)
      })
      expect(await Promise.race([reading, deadline])).toBe("AbortError")
      await expect.poll(() => closedRequests.has(path)).toBe(true)
    } finally {
      clearTimeout(timer)
      heldResponses.get(path)?.()
      await reading
    }
  })

  test("interrupting its Effect before headers closes the server connection", async () => {
    const path = `/headers-held?request=${crypto.randomUUID()}`
    const fiber = Effect.runFork(ShapeSource.fetchSource.request(`${origin}${path}`, {}))
    try {
      await expect.poll(() => receivedRequests.has(path)).toBe(true)
      await Effect.runPromise(Fiber.interrupt(fiber))
      expect(Exit.hasInterrupts(await Effect.runPromise(Fiber.await(fiber)))).toBe(true)
      await expect.poll(() => closedRequests.has(path)).toBe(true)
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber))
      heldResponses.get(path)?.()
    }
  })

  test("a request with a null caller signal still reads its body", async () => {
    const response = await Effect.runPromise(
      ShapeSource.fetchSource.request(`${origin}/v1/shape?offset=-1`, { signal: null })
    )
    expect(await response.json()).toEqual({ url: "/v1/shape?offset=-1" })
  })

  test("sends a request with the fetch in FetchHttpClient.Fetch and answers with the response", async () => {
    const text = await Effect.runPromise(Effect.flatMap(request("/v1/shape?offset=-1"), body))
    expect(JSON.parse(text)).toEqual({ url: "/v1/shape?offset=-1" })
  })

  test("never reads or keeps a response in the HTTP cache: every request is sent with cache: no-store", async () => {
    const sent: Array<RequestInit | undefined> = []
    const recording: typeof globalThis.fetch = (input, init) => {
      sent.push(init)
      return globalThis.fetch(input, init)
    }
    const text = await Effect.runPromise(
      Effect.flatMap(request("/v1/shape?offset=-1"), body).pipe(
        Effect.provideService(FetchHttpClient.Fetch, recording)
      )
    )
    expect(JSON.parse(text)).toEqual({ url: "/v1/shape?offset=-1" })
    expect(sent).toEqual([expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) })])
  })

  test("sends a live request at low priority and every other request at the default, so long polls never queue a page's requests", async () => {
    // A browser opens at most six HTTP/1.1 connections to one origin. On a page whose shapes long-poll on all six,
    // its other requests (a write, a sign-out) waited for a whole long poll, 20 s, and missed their own deadlines
    // forever; a request at a higher priority takes the next free connection first.
    const sent: Array<RequestInit | undefined> = []
    const recording: typeof globalThis.fetch = (input, init) => {
      sent.push(init)
      return globalThis.fetch(input, init)
    }
    const send = (path: string, init: RequestInit = {}) =>
      Effect.runPromise(
        Effect.gen(function*() {
          const source = yield* ShapeSource.ShapeSource
          return yield* Effect.flatMap(source.request(`${origin}${path}`, init), body)
        }).pipe(Effect.provideService(FetchHttpClient.Fetch, recording))
      )
    await send("/v1/shape?offset=0_0&handle=h&live=true")
    await send("/v1/shape?offset=-1")
    await send("/v1/shape?offset=0_0&handle=h&live=false", { priority: "high" })
    expect(sent.map((init) => init?.priority)).toEqual(["low", undefined, "high"])
  })

  test("fails with RequestFailed, without a status, when nothing answers", async () => {
    const error = await Effect.runPromise(
      Effect.flip(Effect.gen(function*() {
        const source = yield* ShapeSource.ShapeSource
        return yield* source.request("http://127.0.0.1:9/v1/shape", {})
      }))
    )
    expect(error).toMatchObject({ _tag: "RequestFailed" })
    expect(error.status).toBeUndefined()
  })
})

describe("a gated source", () => {
  test("sends nothing while closed, each request once open, and waits again when closed", async () => {
    const sent: Array<string> = []
    const recording: ShapeSource.Source = {
      cacheNamespace: "realm",
      request: (url) => Effect.sync(() => (sent.push(url), new Response("[]")))
    }
    await Effect.runPromise(Effect.gen(function*() {
      const open = yield* SubscriptionRef.make(false)
      const source = ShapeSource.gated(recording, SubscriptionRef.changes(open))
      expect(source.cacheNamespace).toBe("realm")
      const first = yield* Effect.forkChild(source.request("https://example.test/v1/shape?offset=-1", {}))
      yield* Effect.yieldNow
      expect(sent).toEqual([])
      yield* SubscriptionRef.set(open, true)
      expect((yield* Fiber.join(first)).status).toBe(200)
      yield* source.request("https://example.test/v1/shape?offset=0_0&live=true", {})
      yield* SubscriptionRef.set(open, false)
      const later = yield* Effect.forkChild(source.request("https://example.test/v1/shape?offset=1_0&live=true", {}))
      yield* Effect.yieldNow
      expect(sent).toHaveLength(2)
      yield* SubscriptionRef.set(open, true)
      yield* Fiber.join(later)
    }))
    expect(sent).toEqual([
      "https://example.test/v1/shape?offset=-1",
      "https://example.test/v1/shape?offset=0_0&live=true",
      "https://example.test/v1/shape?offset=1_0&live=true"
    ])
  })

  test("a stream that ends without opening leaves the request waiting, never sent", async () => {
    let sent = 0
    const recording: ShapeSource.Source = { request: () => Effect.sync(() => (sent += 1, new Response("[]"))) }
    const exit = await Effect.runPromise(Effect.exit(
      ShapeSource.gated(recording, Stream.make(false)).request("https://example.test/v1/shape", {}).pipe(
        Effect.timeout("20 millis")
      )
    ))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(sent).toBe(0)
  })
})

describe("the faulty source", () => {
  const faulty = <A, E>(use: (faults: ShapeSource.Switches) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.flatMap(ShapeSource.Faults, use).pipe(Effect.provide(ShapeSource.layerFaulty())))

  test("is the real source until a switch is thrown, and records every request", async () => {
    const result = await faulty((faults) =>
      Effect.gen(function*() {
        const text = yield* Effect.flatMap(request("/v1/shape?offset=-1"), body)
        return { text, sent: (yield* faults.sent).map((url) => url.search) }
      })
    )
    expect(JSON.parse(result.text)).toEqual({ url: "/v1/shape?offset=-1" })
    expect(result.sent).toEqual(["?offset=-1"])
  })

  test("down fails every request on the network; refuse answers with a status, 400 unless told", async () => {
    const result = await faulty((faults) =>
      Effect.gen(function*() {
        yield* faults.down()
        const down = yield* Effect.flip(request("/v1/shape?offset=-1"))
        yield* faults.refuse()
        const refused = (yield* request("/v1/shape?offset=-1")).status
        yield* faults.refuse(503)
        const unavailable = (yield* request("/v1/shape?offset=-1")).status
        return { down: down._tag, refused, unavailable }
      })
    )
    expect(result).toEqual({ down: "RequestFailed", refused: 400, unavailable: 503 })
  })

  test("a fault for live requests leaves the others to the real source", async () => {
    const result = await faulty((faults) =>
      Effect.gen(function*() {
        yield* faults.refuse(400, "live")
        const live = (yield* request("/v1/shape?offset=1_0&live=true")).status
        const plain = (yield* request("/v1/shape?offset=1_0")).status
        return { live, plain }
      })
    )
    expect(result).toEqual({ live: 400, plain: 200 })
  })

  test("stall holds responses from the real source until heal", async () => {
    const result = await faulty((faults) =>
      Effect.gen(function*() {
        yield* faults.stall()
        const before = answered
        const fiber = yield* Effect.forkChild(request("/v1/shape?offset=-1"))
        // The server has answered; the source still holds the response.
        yield* Effect.suspend(() => (answered > before ? Effect.void : Effect.fail("not yet"))).pipe(
          Effect.retry(Schedule.spaced("10 millis")),
          Effect.timeout("5 seconds"),
          Effect.orDie
        )
        const held = fiber.pollUnsafe() === undefined
        yield* faults.heal
        return { held, status: (yield* Fiber.join(fiber)).status }
      })
    )
    expect(result).toEqual({ held: true, status: 200 })
  })

  test("a stall thrown while a request waits at the server holds its response too", async () => {
    const result = await faulty((faults) =>
      Effect.gen(function*() {
        const before = answered
        const fiber = yield* Effect.forkChild(request("/slow?live=true"))
        yield* Effect.suspend(() => (slowWaiting ? Effect.void : Effect.fail("not yet"))).pipe(
          Effect.retry(Schedule.spaced("10 millis")),
          Effect.timeout("5 seconds"),
          Effect.orDie
        )
        yield* faults.stall("live")
        answerSlow()
        yield* Effect.suspend(() => (answered > before ? Effect.void : Effect.fail("not yet"))).pipe(
          Effect.retry(Schedule.spaced("10 millis")),
          Effect.timeout("5 seconds"),
          Effect.orDie
        )
        const held = fiber.pollUnsafe() === undefined
        yield* faults.heal
        return { held, status: (yield* Fiber.join(fiber)).status }
      })
    )
    expect(result).toEqual({ held: true, status: 200 })
  })

  test("start throws switches before the source is used", async () => {
    const error = await Effect.runPromise(
      Effect.flip(request("/v1/shape?offset=-1")).pipe(
        Effect.provide(ShapeSource.layerFaulty((faults) => faults.down()))
      )
    )
    expect(error._tag).toBe("RequestFailed")
  })

  test("corrupt answers with the real status and headers, and a body cut short", async () => {
    const response = await faulty((faults) => Effect.andThen(faults.corrupt(), request("/v1/shape?offset=-1")))
    expect([response.status, response.headers.get("electric-offset"), await response.text()]).toEqual([
      200,
      "1_0",
      "[{"
    ])
  })

  test("cut ends a body after its first bytes, or its last when negative, keeping the status and headers", async () => {
    const whole = JSON.stringify({ url: "/v1/shape?offset=-1" })
    const result = await faulty((faults) =>
      Effect.gen(function*() {
        yield* faults.cut(5)
        const head = yield* request("/v1/shape?offset=-1")
        yield* faults.cut(-2)
        const tail = yield* Effect.flatMap(request("/v1/shape?offset=-1"), body)
        yield* faults.cut(0, "live")
        const empty = yield* Effect.flatMap(request("/v1/shape?offset=1_0&live=true"), body)
        const plain = yield* Effect.flatMap(request("/v1/shape?offset=1_0"), body)
        return { head: [head.status, head.headers.get("electric-offset"), yield* body(head)], tail, empty, plain }
      })
    )
    expect(result).toEqual({
      head: [200, "1_0", whole.slice(0, 5)],
      tail: whole.slice(0, -2),
      empty: "",
      plain: JSON.stringify({ url: "/v1/shape?offset=1_0" })
    })
  })

  test("drop answers with the status and headers, and reading the body fails after its first bytes", async () => {
    const result = await faulty((faults) =>
      Effect.gen(function*() {
        yield* faults.drop(3)
        const response = yield* request("/v1/shape?offset=-1")
        const reader = response.body!.getReader()
        const first = yield* Effect.promise(() => reader.read())
        const then = yield* Effect.flip(Effect.tryPromise(() => reader.read()))
        return {
          status: response.status,
          offset: response.headers.get("electric-offset"),
          first: new TextDecoder().decode(first.value),
          then: then._tag
        }
      })
    )
    expect(result).toEqual({ status: 200, offset: "1_0", first: `{"u`, then: "UnknownError" })
  })

  test("cut and drop fail on the network when Electric's own body breaks off", async () => {
    const result = await faulty((faults) =>
      Effect.gen(function*() {
        yield* faults.cut(1)
        const cut = yield* Effect.flip(request("/broken"))
        yield* faults.drop(1)
        const dropped = yield* Effect.flip(request("/broken"))
        return [cut, dropped].map((error) => [error._tag, error.status])
      })
    )
    expect(result).toEqual([["RequestFailed", undefined], ["RequestFailed", undefined]])
  })

  test("interrupting a stalled request ends it", async () => {
    const exit = await faulty((faults) =>
      Effect.gen(function*() {
        yield* faults.stall()
        const fiber = yield* Effect.forkChild(request("/v1/shape?offset=-1"))
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      })
    )
    expect(Exit.hasInterrupts(exit)).toBe(true)
  })
})
