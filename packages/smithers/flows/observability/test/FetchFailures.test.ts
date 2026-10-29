import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as Logger from "effect/Logger"
import * as Metric from "effect/Metric"
import * as References from "effect/References"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { FetchFailures } from "../src/index.ts"

// A real server: `/status/<code>` answers that status, `/next` answers each status of `?then=` in turn, `/hang` never
// answers. Requests go through the real `fetch`.
let server: Server
let origin: string
const sequences = new Map<string, Array<number>>()
beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost")
    if (url.pathname === "/hang") return
    if (url.pathname === "/next") {
      const key = url.searchParams.get("key")!
      const remaining = sequences.get(key) ?? url.searchParams.get("then")!.split(",").map(Number)
      const status = remaining.shift()!
      sequences.set(key, remaining)
      response.writeHead(status).end()
      return
    }
    response.writeHead(Number(url.pathname.split("/")[2])).end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() =>
  new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
)

interface Line {
  readonly message: unknown
  readonly level: string
  readonly annotations: Readonly<Record<string, unknown>>
}

// Every path is recorded under its first segment's template, but `/ignored`.
const route = (url: URL) => url.pathname.startsWith("/ignored") ? undefined : `/${url.pathname.split("/")[1]}/:id`

/** Runs `effect` with `FetchFailures.layer` over the real fetch, a recording logger and a fresh registry. */
const observing = <A, E>(effect: Effect.Effect<A, E>, options: Partial<FetchFailures.Options> = {}) => {
  const lines: Array<Line> = []
  const logger = Logger.make(({ message, logLevel, fiber }) =>
    void lines.push({
      message: (message as ReadonlyArray<unknown>)[0],
      level: logLevel,
      annotations: fiber.getRef(References.CurrentLogAnnotations)
    })
  )
  return effect.pipe(
    Effect.provide(FetchFailures.layer({ route, ...options })),
    Effect.provide(Logger.layer([logger])),
    Effect.provideService(Metric.MetricRegistry, new Map()),
    Effect.map((value) => ({ value, lines }))
  )
}

const fetchWith = (input: RequestInfo | URL, init?: RequestInit) =>
  Effect.gen(function*() {
    const fetch = yield* FetchHttpClient.Fetch
    return yield* Effect.promise(() =>
      fetch(input, init).then((response) => response.status, () => "rejected" as const)
    )
  })

const count = (attributes: Record<string, string>) =>
  Metric.value(Metric.withAttributes(FetchFailures.failures, attributes)).pipe(Effect.map((state) => state.count))

describe("FetchFailures", () => {
  it.effect("records a failed request once per run of failures, counts every one, and its recovery", () =>
    observing(Effect.gen(function*() {
      const url = `${origin}/next?key=run&then=503,503,500,200,200`
      const statuses = [yield* fetchWith(url), yield* fetchWith(url), yield* fetchWith(url), yield* fetchWith(url)]
      yield* fetchWith(url)
      return {
        statuses,
        first: yield* count({ route: "/next/:id", method: "GET", statusClass: "5xx", retried: "false" }),
        retries: yield* count({ route: "/next/:id", method: "GET", statusClass: "5xx", retried: "true" })
      }
    })).pipe(Effect.map(({ value, lines }) => {
      expect(value).toEqual({ statuses: [503, 503, 500, 200], first: 1, retries: 2 })
      expect(lines.map(({ message, level, annotations }) => [message, level, annotations])).toEqual([
        ["http.request.failed", "Error", {
          route: "/next/:id",
          method: "GET",
          status: 503,
          statusClass: "5xx",
          retried: false,
          failures: 1
        }],
        // The same request failing with another status is recorded again.
        ["http.request.failed", "Error", {
          route: "/next/:id",
          method: "GET",
          status: 500,
          statusClass: "5xx",
          retried: true,
          failures: 3
        }],
        ["http.request.recovered", "Info", { route: "/next/:id", method: "GET", failures: 3 }]
      ])
    })))

  it.effect("records a 4xx at Warn, by the request's method, and never its path or query", () =>
    observing(Effect.gen(function*() {
      yield* fetchWith(new Request(`${origin}/status/404?secret=hidden`, { method: "post" }))
      yield* fetchWith(new URL(`${origin}/status/409`), { method: "PUT" })
      return yield* count({ route: "/status/:id", method: "POST", statusClass: "4xx", retried: "false" })
    })).pipe(Effect.map(({ value, lines }) => {
      expect(value).toBe(1)
      expect(lines.map(({ level, annotations }) => [level, annotations.method, annotations.status])).toEqual([
        ["Warn", "POST", 404],
        ["Warn", "PUT", 409]
      ])
      expect(JSON.stringify(lines)).not.toContain("hidden")
    })))

  it.effect("records a request that got no answer as `network`, but not one its caller aborted", () =>
    observing(Effect.gen(function*() {
      const closed = createServer()
      yield* Effect.promise(() => new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve)))
      const port = (closed.address() as AddressInfo).port
      yield* Effect.promise(() => new Promise<void>((resolve) => closed.close(() => resolve())))
      const refused = yield* fetchWith(`http://127.0.0.1:${port}/down/1`)
      const controller = new AbortController()
      const aborted = yield* Effect.forkChild(fetchWith(`${origin}/hang/1`, { signal: controller.signal }))
      const fromRequest = new AbortController()
      const abortedRequest = yield* Effect.forkChild(
        fetchWith(new Request(`${origin}/hang/2`, { signal: fromRequest.signal }))
      )
      yield* Effect.yieldNow
      controller.abort()
      fromRequest.abort()
      return {
        refused,
        aborted: yield* Fiber.join(aborted),
        abortedRequest: yield* Fiber.join(abortedRequest),
        network: yield* count({ route: "/down/:id", method: "GET", statusClass: "network", retried: "false" })
      }
    })).pipe(Effect.map(({ value, lines }) => {
      expect(value).toEqual({ refused: "rejected", aborted: "rejected", abortedRequest: "rejected", network: 1 })
      expect(lines.map(({ level, annotations }) => [level, annotations.route, annotations.status])).toEqual([
        ["Warn", "/down/:id", 0]
      ])
    })))

  it.effect("leaves alone a request its route doesn't name, and a success that followed no failure", () =>
    observing(Effect.gen(function*() {
      yield* fetchWith(`${origin}/ignored/500`)
      yield* fetchWith(`${origin}/status/204`)
    })).pipe(Effect.map(({ lines }) => expect(lines).toEqual([]))))

  it.effect("forgets the oldest failing request past `remember`, so its next failure starts a new run", () =>
    observing(
      Effect.gen(function*() {
        yield* fetchWith(`${origin}/status/500?a`)
        yield* fetchWith(`${origin}/status/500?b`)
        yield* fetchWith(`${origin}/status/500?a`)
        return yield* count({ route: "/status/:id", method: "GET", statusClass: "5xx", retried: "false" })
      }),
      { remember: 1 }
    ).pipe(Effect.map(({ value, lines }) => {
      expect(value).toBe(3)
      expect(lines).toHaveLength(3)
    })))

  it.effect("is the fetch Effect's HttpClient sends through, and keeps the fetch's own properties", () =>
    Effect.gen(function*() {
      const marked = Object.assign(globalThis.fetch.bind(globalThis), { preconnect: "kept" })
      const { value, lines } = yield* observing(
        Effect.gen(function*() {
          const fetch = yield* FetchHttpClient.Fetch
          const response = yield* HttpClient.get(`${origin}/status/502`)
          return { status: response.status, preconnect: (fetch as unknown as { preconnect: string }).preconnect }
        }).pipe(Effect.provide(FetchHttpClient.layer))
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, marked))
      expect(value).toEqual({ status: 502, preconnect: "kept" })
      expect(lines.map(({ annotations }) => annotations.status)).toEqual([502])
    }))

  it.effect("resolves a relative request against the page's location", () =>
    Effect.gen(function*() {
      const global = globalThis as { location?: unknown }
      global.location = { href: `${origin}/` }
      const result = yield* observing(fetchWith("/status/500")).pipe(
        Effect.ensuring(Effect.sync(() => delete global.location))
      )
      expect(result.lines.map(({ annotations }) => annotations.route)).toEqual(["/status/:id"])
    }))

  it("names a status's class, and no class for what didn't fail", () => {
    expect(FetchFailures.statusClass({ status: 200, type: "basic" })).toBeUndefined()
    expect(FetchFailures.statusClass({ status: 304, type: "basic" })).toBeUndefined()
    expect(FetchFailures.statusClass({ status: 0, type: "opaqueredirect" })).toBeUndefined()
    expect(FetchFailures.statusClass({ status: 0, type: "error" })).toBe("network")
    expect(FetchFailures.statusClass({ status: 429, type: "basic" })).toBe("4xx")
    expect(FetchFailures.statusClass({ status: 503, type: "basic" })).toBe("5xx")
  })
})
