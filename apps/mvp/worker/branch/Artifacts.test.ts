// A run's artifacts (worker/branch/Artifacts.ts, docs/features/ci.md#artifacts) in Node, over Miniflare's real R2
// through its Node proxy, which takes and gives a body as bytes; each request is a Web `Request` through the handler a job box's
// object runs. worker/branch/Artifacts.workerd.test.ts runs the same handler in workerd over its own R2 binding, with
// streamed bodies and `FixedLengthStream`. A store that fails is a bucket whose every call rejects.
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Effect, Logger, Metric } from "effect"
import { HttpEffect, HttpServerRequest } from "effect/http"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import * as Artifacts from "./Artifacts.ts"

let worker: Miniflare
let bucket: Artifacts.Bucket
let stored: (key: string) => Promise<number | undefined>
beforeAll(async () => {
  worker = new Miniflare({ workers: [{ config: {
    name: "artifacts",
    compatibilityDate: "2026-10-01",
    manifest: {
      mainModule: "worker.js",
      modules: { "worker.js": { type: "esm", contents: "export default { fetch: () => new Response(null, { status: 404 }) }" } },
    },
    env: { ARTIFACTS: { type: "r2" } },
  } }] })
  const r2 = await worker.getR2Bucket("ARTIFACTS")
  stored = async (key) => (await r2.head(key))?.size
  bucket = {
    put: async (key, value) => r2.put(key, value === null ? null : await new Response(value).arrayBuffer()),
    get: async (key) => {
      const object = await r2.get(key)
      return object === null ? null : { size: object.size, body: new Response(await object.arrayBuffer()).body! }
    },
  }
}, 60_000)
afterAll(() => worker?.dispose())

/** The handler a box's object runs over `store`, its scope the `x-scope` header; the lines it logged and its counts. */
const serve = (store: () => Artifacts.Bucket) => {
  const lines: Array<ReturnType<typeof StructuredLogger.formatStructured.log>> = []
  const registry: Metric.MetricRegistry = new Map()
  const handler = HttpEffect.toWebHandler(
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      Artifacts.answer(request, request.headers["x-scope"]).pipe(
        Effect.provide(Artifacts.layerR2(store(), () => new TransformStream())),
      )).pipe(
        Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((options) => void lines.push(StructuredLogger.formatStructured.log(options)))])),
        Effect.provideService(Metric.MetricRegistry, registry),
      ),
  )
  const counted = (method: string, outcome: string) =>
    Effect.runSync(
      Metric.value(Metric.withAttributes(Artifacts.requests, { method, outcome })).pipe(
        Effect.provideService(Metric.MetricRegistry, registry),
      ),
    ).count
  const send = (path: string, init: RequestInit & { readonly scope?: string } = {}) => {
    const { scope, ...rest } = init
    const headers = new Headers(rest.headers)
    if (scope !== undefined) headers.set("x-scope", scope)
    // What a box's client sends with a body of known length; a streamed body has none.
    const known = typeof rest.body === "string" ? new TextEncoder().encode(rest.body) : rest.body
    if (known instanceof Uint8Array && !headers.has("content-length")) headers.set("content-length", String(known.length))
    return handler(new Request(`http://${Artifacts.ARTIFACTS_HOST}${path}`, { ...rest, headers }))
  }
  return { send, lines, counted }
}

const RUN_A = "a".repeat(40)
const RUN_B = "b".repeat(40)

describe("a box's artifacts", () => {
  test("a PUT stores the body under the run's scope and a GET streams it back; another run's scope can't read it", async () => {
    const box = serve(() => bucket)
    const body = new Uint8Array(3 * 1024 * 1024).map((_, index) => index % 251)
    const put = await box.send("/blob-1.json", { method: "PUT", body, scope: RUN_A })
    expect(put.status).toBe(201)
    expect(await stored(Artifacts.keyOf(RUN_A, "blob-1.json"))).toBe(body.length)

    const got = await box.send("/blob-1.json", { scope: RUN_A })
    expect(got.status).toBe(200)
    expect(got.headers.get("content-length")).toBe(String(body.length))
    expect(Buffer.from(await got.arrayBuffer()).equals(Buffer.from(body))).toBe(true)

    expect((await box.send("/blob-1.json", { scope: RUN_B })).status).toBe(404)
    expect((await box.send("/missing", { scope: RUN_A })).status).toBe(404)
    // An empty artifact is an artifact.
    expect((await box.send("/empty", { method: "PUT", headers: { "content-length": "0" }, scope: RUN_A })).status).toBe(201)
    expect(await (await box.send("/empty", { scope: RUN_A })).text()).toBe("")

    expect(box.counted("PUT", "stored")).toBe(2)
    expect(box.counted("GET", "read")).toBe(2)
    expect(box.counted("GET", "absent")).toBe(2)
    // Each request logs its method, outcome and size: never its name, scope or content.
    expect(box.lines[0]).toMatchObject({
      message: "sandbox.artifact",
      level: "INFO",
      annotations: { method: "PUT", outcome: "stored", bytes: body.length },
    })
    expect(JSON.stringify(box.lines)).not.toMatch(/blob-1|aaaa/)
  })

  test("refused: no scope 403, a bad name 400, another method 405, no length 411, over 512 MiB 413", async () => {
    const box = serve(() => bucket)
    expect((await box.send("/a")).status).toBe(403)
    expect((await box.send("/a", { method: "PUT", body: "x" })).status).toBe(403)
    for (const name of ["/", "/.hidden", "/a/b", "/a%2Fb", `/${"a".repeat(129)}`, "/a b"]) {
      expect((await box.send(name, { scope: RUN_A })).status).toBe(400)
    }
    expect((await box.send(`/${"a".repeat(128)}`, { scope: RUN_A })).status).toBe(404)
    expect((await box.send("/a", { method: "DELETE", scope: RUN_A })).status).toBe(405)
    expect((await box.send("/a", { method: "POST", body: "x" })).status).toBe(405)
    const stream = new ReadableStream({ start: (controller) => (controller.enqueue(new Uint8Array([1])), controller.close()) })
    expect((await box.send("/a", { method: "PUT", body: stream, duplex: "half", scope: RUN_A } as RequestInit)).status).toBe(411)
    const over = String(Artifacts.MAX_BYTES + 1)
    expect((await box.send("/a", { method: "PUT", headers: { "content-length": over }, scope: RUN_A })).status).toBe(413)
    expect((await box.send("/a", { scope: RUN_A })).status).toBe(404)
    expect([box.counted("GET", "no_scope"), box.counted("PUT", "no_scope"), box.counted("other", "method")]).toEqual([1, 1, 2])
    expect([box.counted("PUT", "length_required"), box.counted("PUT", "too_large")]).toEqual([1, 1])
    expect(box.lines.find((line) => line.annotations?.outcome === "too_large")).toMatchObject({
      annotations: { method: "PUT", bytes: Artifacts.MAX_BYTES + 1 },
    })
  })

  test("a store that fails answers 502, for a write and a read", async () => {
    const down = () => Promise.reject(new Error("r2 down"))
    const box = serve(() => ({ put: down, get: down }))
    expect((await box.send("/a", { method: "PUT", body: "x", scope: RUN_A })).status).toBe(502)
    expect((await box.send("/a", { scope: RUN_A })).status).toBe(502)
    expect([box.counted("PUT", "store_failed"), box.counted("GET", "store_failed")]).toEqual([1, 1])
  })
})
