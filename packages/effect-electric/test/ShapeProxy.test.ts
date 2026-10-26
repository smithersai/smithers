import { PgClient } from "@effect/sql-pg"
import { isChangeMessage, ShapeStream } from "@electric-sql/client"
import { ConfigProvider, Effect, Fiber, Layer, Logger, Metric, Redacted, References, Tracer } from "effect"
import { FetchHttpClient, HttpEffect, HttpServerRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"
import { ShapeProxy } from "../src/index.ts"

// The proxy as a host mounts it, behind `HttpEffect.toWebHandler`, calling the compose Electric (`ELECTRIC_URL`,
// default http://localhost:30001) through a fetch that records each upstream URL and can inject a fault. A full shape
// over a real table needs the Postgres Electric replicates (`DATABASE_URL`). Each is skipped, saying so, only when it
// can't be reached.

const ELECTRIC_URL = process.env.ELECTRIC_URL ?? "http://localhost:30001"
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://smithers:smithers@localhost:54321/smithers"

const unreachable = (error: unknown) =>
  error instanceof Error &&
  (error.name === "TimeoutError" ||
    ["ECONNREFUSED", "ENOTFOUND"].includes((error.cause as { code?: string })?.code ?? ""))

const electricUp = await fetch(`${ELECTRIC_URL}/v1/health`, { signal: AbortSignal.timeout(2_000) }).then(
  (response) => {
    if (!response.ok) throw new Error(`Electric at ${ELECTRIC_URL} answered ${response.status} to /v1/health`)
    return true
  },
  (error: unknown) => {
    if (!unreachable(error)) throw error
    console.warn(`Electric-backed proxy tests skipped: nothing answers at ELECTRIC_URL=${ELECTRIC_URL}.`)
    return false
  }
)

const postgres = PgClient.layer({ url: Redacted.make(DATABASE_URL) })
const postgresUp = electricUp &&
  await Effect.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`select 1`).pipe(
      Effect.provide(postgres),
      Effect.timeout("3 seconds"),
      Effect.as(true),
      Effect.catchCause((cause) => {
        const error = (cause.reasons[0] as { error?: { cause?: unknown } } | undefined)?.error
        if (!unreachable(error?.cause ?? error)) return Effect.failCause(cause)
        console.warn(`The real-table tests are skipped: no Postgres at DATABASE_URL=${DATABASE_URL}.`)
        return Effect.succeed(false)
      })
    )
  )

type Fault =
  | { readonly _tag: "down" }
  | { readonly _tag: "answer"; readonly headers: Record<string, string> }
  | { readonly _tag: "hold" }
  | { readonly _tag: "breakBody" }
  | { readonly _tag: "endlessBody" }

/** The proxy with `options`, recording every log line, span, count and upstream URL. */
const harness = (options: Partial<ShapeProxy.Options<HttpServerRequest.HttpServerRequest>> = {}) => {
  const upstream: Array<URL> = []
  const upstreamHeaders: Array<Headers> = []
  const logs: Array<{ message: unknown; level: string; annotations: Record<string, unknown> }> = []
  const spans: Array<Tracer.NativeSpan> = []
  const registry = new Map()
  let fault: Fault | undefined
  let held = 0

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    upstream.push(url)
    upstreamHeaders.push(new Headers(input instanceof Request ? input.headers : init?.headers))
    switch (fault?._tag) {
      case "down":
        throw new TypeError("fetch failed")
      case "hold":
        held++
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
        })
      case "breakBody":
        let pulls = 0
        return new Response(
          new ReadableStream({
            pull: (controller) => {
              if (pulls++ === 0) controller.enqueue(new TextEncoder().encode("[{\"partial\""))
              else controller.error(new Error("connection reset"))
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      case "answer":
        return new Response("[]", { status: 200, headers: fault.headers })
      case "endlessBody":
        return new Response(
          new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode("[")) }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      case undefined:
        return globalThis.fetch(input, init)
    }
  }
  const tracer = Tracer.make({
    span(spanOptions) {
      const span = new Tracer.NativeSpan(spanOptions)
      spans.push(span)
      return span
    }
  })
  const recorder = Logger.make(({ message, logLevel, fiber }) => {
    logs.push({ message, level: logLevel, annotations: { ...fiber.getRef(References.CurrentLogAnnotations) } })
  })
  const program = ShapeProxy.make({ url: ELECTRIC_URL, shape: { table: "items" }, ...options }).pipe(
    Effect.provide(Layer.mergeAll(FetchHttpClient.layer, Logger.layer([recorder]))),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.provideService(Tracer.Tracer, tracer),
    Effect.provideService(Metric.MetricRegistry, registry)
  )
  const handler = HttpEffect.toWebHandler(program)
  return {
    upstream,
    upstreamHeaders,
    logs,
    spans,
    held: () => held,
    fault: (next: Fault | undefined) => {
      fault = next
    },
    request: (search: string, init?: RequestInit) => handler(new Request(`http://app.test/api/shape${search}`, init)),
    /** The route as a browser's `fetch` reaches it, for an Electric client. */
    fetch: (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init)),
    /** The handler as a host runs it, in a fiber the host interrupts when the browser goes away. */
    fork: (search: string) =>
      Effect.runFork(
        Effect.provideService(
          program,
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request(`http://app.test/api/shape${search}`))
        )
      ),
    count: (metric: Metric.Counter<number>, attributes: Record<string, string>) =>
      Effect.runSync(
        Metric.value(Metric.withAttributes(metric, attributes)).pipe(
          Effect.provideService(Metric.MetricRegistry, registry)
        )
      ).count,
    line: () => logs.at(-1),
    /** The proxy's own span: the server span, not the HTTP client's. */
    span: () => spans.find(({ kind }) => kind === "server")!
  }
}

const until = (assertion: () => void) => vi.waitFor(assertion, { timeout: 5_000, interval: 10 })

describe("refusals: no Electric needed", () => {
  test("another method is 405, and Electric is never called", async () => {
    const h = harness()
    const response = await h.request("?offset=-1", { method: "POST" })
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("GET")
    expect(h.upstream).toEqual([])
    expect(h.line()).toMatchObject({
      message: ["electric.shape"],
      level: "Warn",
      annotations: { status: 405, live: false, bytes: 0, outcome: "complete" }
    })
    expect(h.line()?.annotations).not.toHaveProperty("subset")
  })

  test("a shape the host decides per request: its refusal is answered, recorded, and never reaches Electric", async () => {
    const decide = Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const who = new URL(request.url, "http://localhost").searchParams.get("who")
      if (who === "stranger") return yield* new ShapeProxy.Refused({ status: 403 })
      if (who === null) return yield* new ShapeProxy.Refused({ status: 401 })
      if (who === "blip") return yield* new ShapeProxy.Refused({ status: 503, retryAfter: 5, upstream: "database" })
      return { table: "items", where: "owner = $1", params: { "1": who } }
    })
    const h = harness({ shape: decide })
    const answers = []
    for (const who of ["", "&who=stranger", "&who=blip"]) {
      const response = await h.request(`?offset=-1&handle=h-1${who}`)
      answers.push({
        status: response.status,
        cacheControl: response.headers.get("cache-control"),
        retryAfter: response.headers.get("retry-after"),
        body: await response.text(),
        level: h.line()?.level,
        logged: h.line()?.annotations.status
      })
    }
    expect(answers).toEqual([
      { status: 401, cacheControl: "private, no-store", retryAfter: null, body: "", level: "Warn", logged: 401 },
      { status: 403, cacheControl: "private, no-store", retryAfter: null, body: "", level: "Warn", logged: 403 },
      { status: 503, cacheControl: "private, no-store", retryAfter: "5", body: "", level: "Error", logged: 503 }
    ])
    expect(h.upstream).toEqual([])
    expect(h.logs.map((line) => line.annotations.upstream)).toEqual(["access", "access", "database"])
    expect(h.count(ShapeProxy.responses, { name: "electric.shape", statusClass: "4xx" })).toBe(2)
    expect(h.count(ShapeProxy.responses, { name: "electric.shape", statusClass: "5xx" })).toBe(1)
    expect(new Set(h.logs.map((line) => line.annotations.correlationId)).size).toBe(3)
    expect(h.count(ShapeProxy.defaultMetric, { status: "503", live: "false" })).toBe(1)
    const servers = h.spans.filter(({ kind }) => kind === "server")
    expect(servers.map(({ attributes }) => attributes.get("http.response.status_code"))).toEqual([401, 403, 503])

    h.fault({ _tag: "down" })
    await h.request("?offset=-1&who=person-1&params%5B1%5D=person-2")
    expect([...h.upstream[0]!.searchParams]).toEqual([
      ["offset", "-1"],
      ["params[1]", "person-1"],
      ["table", "items"],
      ["where", "owner = $1"]
    ])
  })

  test("a defect deciding a shape answers 500 with one content-free record", async () => {
    const h = harness({ shape: Effect.die(new Error("PRIVATE-DECISION-CONTENT")) })
    const response = await h.request("?offset=-1")
    expect(response.status).toBe(500)
    expect(h.upstream).toEqual([])
    expect(h.logs).toHaveLength(1)
    expect(h.line()?.annotations).toMatchObject({ status: 500, upstream: "access", statusClass: "5xx" })
    expect(JSON.stringify(h.logs)).not.toContain("PRIVATE-DECISION-CONTENT")
    expect(h.count(ShapeProxy.responses, { name: "electric.shape", statusClass: "5xx" })).toBe(1)
  })

  test("abandoning a shape decision records exactly one abort without contacting Electric", async () => {
    const h = harness({ shape: Effect.never })
    const fiber = h.fork("?offset=-1")
    await vi.waitFor(() => expect(h.spans.some((span) => span.kind === "server")).toBe(true))
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(h.logs).toHaveLength(1)
    expect(h.line()?.annotations).toMatchObject({ status: 499, upstream: "access", outcome: "aborted" })
    expect(h.upstream).toEqual([])
  })

  test("a refusal is never kept, even on a public shape", async () => {
    const h = harness({ cache: "public", shape: Effect.fail(new ShapeProxy.Refused({ status: 401 })) })
    expect((await h.request("?offset=-1")).headers.get("cache-control")).toBe("private, no-store")
  })
})

describe("faults: no Electric needed", () => {
  test("502 when Electric can't be reached, recorded at Error", async () => {
    const h = harness()
    h.fault({ _tag: "down" })
    const response = await h.request("?offset=-1&live=true")
    expect(response.status).toBe(502)
    expect(h.line()).toMatchObject({
      level: "Error",
      annotations: { status: 502, live: true, bytes: 0, outcome: "complete" }
    })
    expect(h.span().attributes.get("http.response.status_code")).toBe(502)
    expect(h.count(ShapeProxy.defaultMetric, { status: "502", live: "true" })).toBe(1)
  })

  test("a subset request's parameters are dropped like any other, never forwarded, and recorded nowhere", async () => {
    const h = harness()
    h.fault({ _tag: "down" })
    const subset = {
      subset__where: "lower(\"position\") = $1",
      subset__params: "{\"1\":\"x\"}",
      subset__order_by: "\"text\" DESC",
      subset__limit: "1000",
      subset__offset: "10",
      subset__where_expr: "{}",
      subset__order_by_expr: "[]"
    }
    const response = await h.request(`?${new URLSearchParams({ offset: "-1", ...subset, handle: "h-1" })}`)
    expect(response.status).toBe(502)
    expect([...h.upstream[0]!.searchParams]).toEqual([["handle", "h-1"], ["offset", "-1"], ["table", "items"]])
    expect(h.line()?.annotations).toEqual({
      status: 502,
      route: "electric.shape",
      upstream: "electric",
      correlationId: response.headers.get("x-request-id"),
      statusClass: "5xx",
      live: false,
      durationMs: expect.any(Number),
      bytes: 0,
      outcome: "complete"
    })
    expect(Object.fromEntries(h.span().attributes)).toEqual({
      "http.response.status_code": 502,
      "electric.shape.live": false,
      route: "electric.shape",
      upstream: "electric",
      correlationId: response.headers.get("x-request-id")
    })
    expect(JSON.stringify(h.logs)).not.toContain("lower")
  })

  test("a browser that leaves before Electric answers is recorded once as 499, aborted, at Info", async () => {
    const h = harness()
    h.fault({ _tag: "hold" })
    const fiber = h.fork("?offset=-1&live=true")
    await until(() => expect(h.held()).toBe(1))
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(h.logs).toHaveLength(1)
    expect(h.line()).toMatchObject({ level: "Info", annotations: { status: 499, live: true, outcome: "aborted" } })
  })

  test("a secret sent as a bearer token is in no URL, log line or span: only in the authorization header", async () => {
    const sentinel = "electric-secret-sentinel-7f3a"
    const h = harness({ secret: Redacted.make(sentinel), secretAs: "bearer", sourceId: "source-1" })
    h.fault({ _tag: "down" })
    await h.request(`?offset=-1&secret=${sentinel}x`)
    expect([...h.upstream[0]!.searchParams]).toEqual([["offset", "-1"], ["source_id", "source-1"], ["table", "items"]])
    expect(h.upstreamHeaders[0]!.get("authorization")).toBe(`Bearer ${sentinel}`)
    expect(JSON.stringify(h.logs)).not.toContain(sentinel)
    expect(h.spans.length).toBeGreaterThan(1)
    for (const span of h.spans) expect(JSON.stringify([...span.attributes])).not.toContain(sentinel)
  })

  test("a secret sent as a parameter, the default, sends no authorization header", async () => {
    const h = harness({ secret: Redacted.make("s") })
    h.fault({ _tag: "down" })
    await h.request("?offset=-1")
    expect(h.upstream[0]!.searchParams.get("secret")).toBe("s")
    expect(h.upstreamHeaders[0]!.get("authorization")).toBeNull()
  })

  test("a body that breaks off is recorded at Error as failed, with the bytes sent", async () => {
    const h = harness()
    h.fault({ _tag: "breakBody" })
    const response = await h.request("?offset=-1")
    expect(response.status).toBe(200)
    await response.text().catch(() => null)
    await until(() => expect(h.logs).toHaveLength(1))
    expect(h.line()).toMatchObject({
      level: "Error",
      annotations: { status: 200, outcome: "failed", bytes: "[{\"partial\"".length }
    })
  })

  test("a browser that stops reading mid-body is recorded at Info as aborted", async () => {
    const h = harness()
    h.fault({ _tag: "endlessBody" })
    const response = await h.request("?offset=-1")
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()
    await until(() => expect(h.logs).toHaveLength(1))
    expect(h.line()).toMatchObject({ level: "Info", annotations: { status: 200, outcome: "aborted", bytes: 1 } })
  })
})

describe("caching: no Electric needed", () => {
  // The cache headers Electric 1.8.1 sends with a shape's first response, plus the CDN ones a host's Electric may add.
  const electric = {
    "content-type": "application/json",
    "cache-control": "public, max-age=604800, s-maxage=3600, stale-while-revalidate=2629746",
    etag: "\"h-1:-1:0_0\"",
    "surrogate-control": "max-age=3600",
    "cdn-cache-control": "max-age=3600",
    "electric-handle": "h-1",
    "electric-offset": "0_0"
  }
  const cacheHeaders = (response: Response) =>
    Object.fromEntries(
      ["cache-control", "etag", "surrogate-control", "cdn-cache-control"].map((name) => [
        name,
        response.headers.get(name)
      ])
    )

  test("by default no browser or CDN keeps a response: Electric's cache headers become private, no-store", async () => {
    const h = harness()
    h.fault({ _tag: "answer", headers: electric })
    const response = await h.request("?offset=-1")
    expect(response.status).toBe(200)
    expect(cacheHeaders(response)).toEqual({
      "cache-control": "private, no-store",
      etag: null,
      "surrogate-control": null,
      "cdn-cache-control": null
    })
    expect(response.headers.get("electric-handle")).toBe("h-1")
    expect(response.headers.get("electric-offset")).toBe("0_0")
    expect(await response.text()).toBe("[]")
  })

  test("the proxy's own 405 and 502 aren't kept either", async () => {
    const h = harness({ cache: "no-store" })
    expect((await h.request("?offset=-1", { method: "POST" })).headers.get("cache-control")).toBe("private, no-store")
    h.fault({ _tag: "down" })
    expect((await h.request("?offset=-1")).headers.get("cache-control")).toBe("private, no-store")
  })

  test("a public shape, opted in, passes Electric's cache headers through", async () => {
    const h = harness({ cache: "public" })
    h.fault({ _tag: "answer", headers: electric })
    const response = await h.request("?offset=-1")
    expect(cacheHeaders(response)).toEqual({
      "cache-control": electric["cache-control"],
      etag: electric.etag,
      "surrogate-control": electric["surrogate-control"],
      "cdn-cache-control": electric["cdn-cache-control"]
    })
    expect((await h.request("?offset=-1", { method: "POST" })).headers.get("cache-control")).toBeNull()
  })
})

describe.skipIf(!electricUp)("through Electric", () => {
  test("forwards only the protocol parameters, the first of each, with the host's shape, its columns, and credentials, sorted by name", async () => {
    const secret = "electric-secret-4b2d"
    const h = harness({
      secret: Redacted.make(secret),
      sourceId: "source-1",
      shape: { table: "items", where: "\"position\" > $1", params: { "1": "0" }, columns: ["id", "position"] }
    })
    await h.request(
      "?table=users&offset=-1&where=true&handle=h-1&offset=0_0&live=false&cursor=7&live_sse=false" +
        "&experimental_live_sse=false&expired_handle=h-0&log=full&cache-buster=b&columns=text&replica=full" +
        "&params%5B1%5D=x&secret=stolen&source_id=mine&subset__where_expr=%7B%7D&subset__order_by_expr=%5B%5D"
    )
    expect([...h.upstream[0]!.searchParams]).toEqual([
      ["cache-buster", "b"],
      ["columns", "id,position"],
      ["cursor", "7"],
      ["experimental_live_sse", "false"],
      ["expired_handle", "h-0"],
      ["handle", "h-1"],
      ["live", "false"],
      ["live_sse", "false"],
      ["log", "full"],
      ["offset", "-1"],
      ["params[1]", "0"],
      ["secret", secret],
      ["source_id", "source-1"],
      ["table", "items"],
      ["where", "\"position\" > $1"]
    ])
    expect(`${h.upstream[0]!.origin}${h.upstream[0]!.pathname}`).toBe(`${ELECTRIC_URL}/v1/shape`)
    await until(() => expect(h.logs).toHaveLength(1))
    expect(JSON.stringify(h.logs)).not.toContain(secret)
    for (const span of h.spans) expect(JSON.stringify([...span.attributes])).not.toContain(secret)
    expect(h.spans.find(({ kind }) => kind === "client")?.attributes.get("url.full")).toContain("secret=REDACTED")
  })

  test("streams Electric's 4xx back, recorded at Warn, under the host's own name and counter", async () => {
    const metric = Metric.counter("app_shape_requests", { incremental: true })
    const h = harness({ shape: { table: "no_such_schema.items" }, name: "app.shape", metric })
    const response = await h.request("?offset=-1")
    expect(response.status).toBe(400)
    const body = await response.text()
    await until(() => expect(h.logs).toHaveLength(1))
    expect(h.line()).toMatchObject({
      message: ["app.shape"],
      level: "Warn",
      annotations: { status: 400, live: false, outcome: "complete", bytes: new TextEncoder().encode(body).byteLength }
    })
    expect(h.span()).toMatchObject({ name: "app.shape", kind: "server" })
    expect(h.count(metric, { status: "400", live: "false" })).toBe(1)
  })

  describe.skipIf(!postgresUp)("over a real table", () => {
    const schema = `test_proxy_${crypto.randomUUID().replaceAll("-", "")}`
    const table = `${schema}.items`
    const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      Effect.runPromise(effect.pipe(Effect.provide(postgres)))

    beforeAll(() =>
      run(Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(`create schema ${schema}`)
        yield* sql.unsafe(`create table ${table} (id text primary key, position bigint not null)`)
        yield* sql.unsafe(`insert into ${table} values ('a', 1), ('b', 2), ('c', 3), ('d', 4)`)
      }))
    )
    afterAll(() => run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(`drop schema ${schema} cascade`))))

    test("a full shape request passes Electric's response through, without encoding, length or CORS headers", async () => {
      const h = harness({ shape: { table } })
      const response = await h.request("?offset=-1")
      expect(response.status).toBe(200)
      expect(response.headers.get("electric-handle")).toEqual(expect.any(String))
      for (const name of ["content-encoding", "content-length", "access-control-allow-origin"]) {
        expect(response.headers.get(name)).toBeNull()
      }
      const body = await response.text()
      expect(JSON.parse(body).filter((message: { key?: string }) => message.key !== undefined)).toHaveLength(4)
      await until(() => expect(h.logs).toHaveLength(1))
      expect(h.line()).toMatchObject({
        message: ["electric.shape"],
        level: "Info",
        annotations: {
          status: 200,
          live: false,
          outcome: "complete",
          bytes: new TextEncoder().encode(body).byteLength,
          durationMs: expect.any(Number)
        }
      })
      expect(h.count(ShapeProxy.defaultMetric, { status: "200", live: "false" })).toBe(1)
    })

    test("a public shape, opted in, keeps Electric's own caching", async () => {
      const h = harness({ shape: { table }, cache: "public" })
      const response = await h.request("?offset=-1")
      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toMatch(/^public, max-age=\d+/)
      expect(response.headers.get("etag")).toEqual(expect.any(String))
      await response.text()
    })

    test("an Electric client follows a no-store shape through the proxy: its rows, then a live insert", async () => {
      const h = harness({ shape: { table } })
      const cacheControl: Array<string | null> = []
      const aborted = new AbortController()
      const stream = new ShapeStream({
        url: "http://app.test/api/shape",
        signal: aborted.signal,
        fetchClient: async (input, init) => {
          const response = await h.fetch(input, init)
          cacheControl.push(response.headers.get("cache-control"))
          return response
        }
      })
      const ids = new Set<unknown>()
      let upToDate = false
      const unsubscribe = stream.subscribe((messages) => {
        for (const message of messages) {
          if (isChangeMessage(message)) ids.add(message.value.id)
          else if (message.headers.control === "up-to-date") upToDate = true
        }
      })
      try {
        await until(() => expect(upToDate).toBe(true))
        expect([...ids].sort()).toEqual(["a", "b", "c", "d"])
        await run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(`insert into ${table} values ('e', 5)`)))
        await until(() => expect(ids).toContain("e"))
        expect(h.upstream.some((url) => url.searchParams.get("live") === "true")).toBe(true)
        expect(h.upstream.at(-1)?.searchParams.get("handle")).toEqual(expect.any(String))
        expect(cacheControl.length).toBeGreaterThan(1)
        expect(new Set(cacheControl)).toEqual(new Set(["private, no-store"]))
      } finally {
        unsubscribe()
        aborted.abort()
      }
    })
  })
})

describe("config", () => {
  const read = (env: Record<string, string>, options?: { readonly url?: string }) =>
    Effect.runPromise(
      Effect.provideService(ShapeProxy.config(options), ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env))
        .pipe(
          Effect.result
        )
    )

  test("reads ELECTRIC_URL, ELECTRIC_SECRET as a redacted value, and ELECTRIC_SOURCE_ID", async () => {
    const result = await read({
      ELECTRIC_URL: "https://electric.test",
      ELECTRIC_SECRET: "s",
      ELECTRIC_SOURCE_ID: "src"
    })
    expect(result._tag).toBe("Success")
    const connection = result._tag === "Success" ? result.success : undefined
    expect(connection?.url).toBe("https://electric.test")
    expect(Redacted.isRedacted(connection?.secret)).toBe(true)
    expect(Redacted.value(connection!.secret!)).toBe("s")
    expect(connection?.sourceId).toBe("src")
    expect(connection?.secretAs).toBeUndefined()
  })

  test("reads ELECTRIC_SECRET_AS, parameter or bearer, and refuses anything else", async () => {
    const as = (value: string) => read({ ELECTRIC_URL: "https://electric.test", ELECTRIC_SECRET_AS: value })
    expect(await as("bearer")).toMatchObject({ _tag: "Success", success: { secretAs: "bearer" } })
    expect(await as("parameter")).toMatchObject({ _tag: "Success", success: { secretAs: "parameter" } })
    expect((await as("header"))._tag).toBe("Failure")
  })

  test("falls back to the given url, leaves the credentials out, and needs ELECTRIC_URL without one", async () => {
    expect(await read({}, { url: "http://localhost:30001" })).toMatchObject({
      _tag: "Success",
      success: { url: "http://localhost:30001", secret: undefined, sourceId: undefined }
    })
    expect((await read({}))._tag).toBe("Failure")
  })
})
