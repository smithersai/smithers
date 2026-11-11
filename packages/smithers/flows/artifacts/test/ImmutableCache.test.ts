/**
 * The immutable cache: its contract over the memory backend, its bounds, the
 * read-through combinator, its telemetry, and every backend fault, each
 * injected as a `WebCache` that refuses.
 *
 * The real backends are proven where they live: the Workers Cache API in
 * workerd (`@smthrs/platform-cloudflare`) and Cache Storage in Chromium
 * (`@smthrs/platform-browser`).
 */
import { describe, expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as References from "effect/References"
import * as Tracer from "effect/Tracer"
import { ImmutableCache } from "../src/index.vibe"

const encoder = new TextEncoder()
const utf8 = (text: string) => encoder.encode(text)
const every = Uint8Array.from({ length: 256 }, (_, index) => index)
const secretPath = "src/secret/notes.md"
const blob = ImmutableCache.key("repo.blob", "acme/widgets", "a".repeat(40), secretPath)

/** Everything a program records: spans, log lines and metrics. */
const telemetry = () => {
  const spans: Array<Tracer.NativeSpan> = []
  const logs: Array<{ readonly message: unknown; readonly annotations: Record<string, unknown> }> = []
  const registry = new Map()
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    }
  })
  const recorder = Logger.make(({ fiber, message }) => {
    logs.push({ message, annotations: { ...fiber.getRef(References.CurrentLogAnnotations) } })
  })
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(Logger.layer([recorder])),
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provideService(Metric.MetricRegistry, registry)
    )
  const count = (metric: Metric.Counter<number>, attributes: Record<string, string>) =>
    Effect.runSync(
      Metric.value(Metric.withAttributes(metric, attributes)).pipe(
        Effect.provideService(Metric.MetricRegistry, registry)
      )
    ).count
  /**
   * Every string an exporter could send: span names and attributes, each
   * span's status as OTLP exports it (a failure's errors, never a success's
   * value), log lines, and metric attributes.
   */
  const recorded = () =>
    JSON.stringify(
      [
        spans.map((span) => ({
          name: span.name,
          attributes: Object.fromEntries(span.attributes),
          status: span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
            ? Cause.prettyErrors(span.status.exit.cause).map((error) => [error.name, error.message, error.stack])
            : span.status._tag
        })),
        logs,
        [...registry.keys()]
      ],
      (_, value) => (typeof value === "bigint" ? String(value) : value)
    )
  return { spans, logs, provide, count, recorded }
}

const run = <A, E>(
  effect: Effect.Effect<A, E, ImmutableCache.ImmutableCache>,
  layer: Layer.Layer<ImmutableCache.ImmutableCache, ImmutableCache.ImmutableCacheError> = ImmutableCache.layerMemory()
) => Effect.runPromise(Effect.provide(effect, layer))

const exitOf = <A, E>(
  effect: Effect.Effect<A, E, ImmutableCache.ImmutableCache>,
  layer: Layer.Layer<ImmutableCache.ImmutableCache, unknown>
) => Effect.runPromise(Effect.exit(Effect.provide(effect, layer)))

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  return Option.getOrThrow(Exit.findErrorOption(exit))
}

const get = (key: ImmutableCache.Key) => Effect.flatMap(ImmutableCache.ImmutableCache, (cache) => cache.get(key))
const put = (key: ImmutableCache.Key, entry: ImmutableCache.Entry) =>
  Effect.flatMap(ImmutableCache.ImmutableCache, (cache) => cache.put(key, entry))

/** A cache over `backend`, labelled `fault`. */
const over = (backend: ImmutableCache.WebCache, maxEntryBytes?: number) =>
  Layer.succeed(ImmutableCache.ImmutableCache, ImmutableCache.make(backend, { backend: "fault", maxEntryBytes }))

/** A backend whose stored response is `response`, whatever is asked. */
const answering = (response: () => Response): ImmutableCache.WebCache => ({
  match: async () => response(),
  put: async () => undefined
})

describe("the memory cache", () => {
  it("misses, then answers exactly the bytes and metadata it stored", async () => {
    const result = await run(Effect.gen(function*() {
      const before = yield* get(blob)
      const stored = yield* put(blob, { bytes: every, metadata: { blobSha: "b".repeat(40), type: "text/markdown" } })
      const after = yield* get(blob)
      return { before, stored, after }
    }))
    expect(Option.isNone(result.before)).toBe(true)
    expect(result.stored).toBe("stored")
    const entry = Option.getOrThrow(result.after)
    expect([...entry.bytes]).toEqual([...every])
    expect(entry.metadata).toEqual({ blobSha: "b".repeat(40), type: "text/markdown" })
  })

  it("keeps its own copies: neither the array put nor an array got aliases what is stored", async () => {
    const [first, second] = await run(Effect.gen(function*() {
      const input = utf8("abc")
      yield* put(blob, { bytes: input, metadata: {} })
      input[0] = 0
      const first = Option.getOrThrow(yield* get(blob))
      first.bytes[1] = 0
      const second = Option.getOrThrow(yield* get(blob))
      return [first, second]
    }))
    expect(first.bytes).not.toBe(second.bytes)
    expect(new TextDecoder().decode(second.bytes)).toBe("abc")
    expect(second.metadata).toEqual({})
  })

  it("keys by every part, so parts that join to the same text are different keys", async () => {
    const result = await run(Effect.gen(function*() {
      yield* put(ImmutableCache.key("repo.blob", "a/b"), { bytes: utf8("joined"), metadata: {} })
      yield* put(ImmutableCache.key("repo.tree", "a/b"), { bytes: utf8("tree"), metadata: {} })
      return {
        split: yield* get(ImmutableCache.key("repo.blob", "a", "b")),
        joined: yield* get(ImmutableCache.key("repo.blob", "a/b")),
        tree: yield* get(ImmutableCache.key("repo.tree", "a/b"))
      }
    }))
    expect(Option.isNone(result.split)).toBe(true)
    expect(new TextDecoder().decode(Option.getOrThrow(result.joined).bytes)).toBe("joined")
    expect(new TextDecoder().decode(Option.getOrThrow(result.tree).bytes)).toBe("tree")
  })

  it("stores an entry at its bounds and refuses one over them, storing nothing", async () => {
    const layer = ImmutableCache.layerMemory({ maxEntryBytes: 4 })
    const atBound = { a: "x".repeat(ImmutableCache.maxMetadataBytes - 8) }
    expect(encoder.encode(JSON.stringify(atBound)).byteLength).toBe(ImmutableCache.maxMetadataBytes)
    const result = await run(
      Effect.gen(function*() {
        return {
          four: yield* put(ImmutableCache.key("t", "four"), { bytes: utf8("1234"), metadata: atBound }),
          five: yield* put(ImmutableCache.key("t", "five"), { bytes: utf8("12345"), metadata: {} }),
          // One more byte of metadata, as a two-byte character.
          metadata: yield* put(ImmutableCache.key("t", "meta"), {
            bytes: utf8("1"),
            metadata: { a: "x".repeat(ImmutableCache.maxMetadataBytes - 9) + "é" }
          }),
          fourGot: yield* get(ImmutableCache.key("t", "four")),
          fiveGot: yield* get(ImmutableCache.key("t", "five")),
          metaGot: yield* get(ImmutableCache.key("t", "meta"))
        }
      }),
      layer
    )
    expect([result.four, result.five, result.metadata]).toEqual(["stored", "too_large", "too_large"])
    expect(Option.getOrThrow(result.fourGot).metadata).toEqual(atBound)
    expect(Option.isNone(result.fiveGot)).toBe(true)
    expect(Option.isNone(result.metaGot)).toBe(true)
  })

  it("never lets one entry exceed the total bound, whatever maxEntryBytes says", async () => {
    const outcome = await run(
      put(blob, { bytes: utf8("12345"), metadata: {} }),
      ImmutableCache.layerMemory({ maxEntryBytes: 100, maxTotalBytes: 4 })
    )
    expect(outcome).toBe("too_large")
  })

  it("evicts the least recently used entries past its total bound", async () => {
    const result = await run(
      Effect.gen(function*() {
        const four = utf8("1234")
        yield* put(ImmutableCache.key("t", "a"), { bytes: four, metadata: {} })
        yield* put(ImmutableCache.key("t", "b"), { bytes: four, metadata: {} })
        // Reading `a` makes `b` the least recently used.
        yield* get(ImmutableCache.key("t", "a"))
        yield* put(ImmutableCache.key("t", "c"), { bytes: four, metadata: {} })
        return {
          a: Option.isSome(yield* get(ImmutableCache.key("t", "a"))),
          b: Option.isSome(yield* get(ImmutableCache.key("t", "b"))),
          c: Option.isSome(yield* get(ImmutableCache.key("t", "c")))
        }
      }),
      ImmutableCache.layerMemory({ maxTotalBytes: 10 })
    )
    expect(result).toEqual({ a: true, b: false, c: true })
  })

  it("dies on a namespace that is not a short label, so no path reaches telemetry", async () => {
    for (const namespace of ["", "Repo", "src/index.vibe", "repo blob", "repo..blob", "repo.", "a".repeat(65)]) {
      const exit = await exitOf(get(ImmutableCache.key(namespace, "x")), ImmutableCache.layerMemory())
      expect(Exit.hasDies(exit)).toBe(true)
    }
    const fine = await exitOf(get(ImmutableCache.key("a".repeat(64), "x")), ImmutableCache.layerMemory())
    expect(Exit.isSuccess(fine)).toBe(true)
  })
})

describe("the memory WebCache", () => {
  const response = (body: string) =>
    new Response(body, { headers: { "cache-control": "public, max-age=31536000, immutable", "x-kind": "test" } })

  it("answers a stored response with its headers, and undefined for anything else", async () => {
    const cache = ImmutableCache.makeMemoryWebCache()
    await cache.put("https://cache.test/a", response("alpha"))
    const hit = await cache.match("https://cache.test/a")
    expect(await hit?.text()).toBe("alpha")
    expect(hit?.headers.get("x-kind")).toBe("test")
    expect(await cache.match("https://cache.test/b")).toBeUndefined()
  })

  it("stores nothing larger than its total, and counts a replaced body once", async () => {
    const cache = ImmutableCache.makeMemoryWebCache(10)
    await cache.put("https://cache.test/big", response("12345678901"))
    expect(await cache.match("https://cache.test/big")).toBeUndefined()
    await cache.put("https://cache.test/a", response("1234"))
    await cache.put("https://cache.test/a", response("1234"))
    await cache.put("https://cache.test/b", response("123456"))
    expect(await (await cache.match("https://cache.test/a"))?.text()).toBe("1234")
    expect(await (await cache.match("https://cache.test/b"))?.text()).toBe("123456")
  })
})

describe("a backend that refuses", () => {
  it("fails a get the backend rejects with failed and the error's name", async () => {
    const backend: ImmutableCache.WebCache = {
      match: () => Promise.reject(new DOMException("full of secrets", "QuotaExceededError")),
      put: async () => undefined
    }
    const error = failureOf(await exitOf(get(blob), over(backend)))
    expect(error).toEqual(
      new ImmutableCache.ImmutableCacheError({
        backend: "fault",
        operation: "get",
        reason: "failed",
        errorName: "QuotaExceededError"
      })
    )
    expect((error as Error).message).toBe("Immutable cache (fault) get failed (QuotaExceededError)")
  })

  it("fails a put the backend rejects, keeping no name that is not an identifier", async () => {
    for (const thrown of ["a string", null, { name: "has spaces and /paths" }, { name: 7 }]) {
      const backend: ImmutableCache.WebCache = { match: async () => undefined, put: () => Promise.reject(thrown) }
      const error = failureOf(await exitOf(put(blob, { bytes: utf8("x"), metadata: {} }), over(backend)))
      expect(error).toEqual(
        new ImmutableCache.ImmutableCacheError({ backend: "fault", operation: "put", reason: "failed" })
      )
      expect((error as Error).message).toBe("Immutable cache (fault) put failed")
    }
  })

  it("fails a get whose stored body breaks off while it is read", async () => {
    const broken = () =>
      new Response(new ReadableStream({ pull: (controller) => controller.error(new TypeError("reset")) }), {
        headers: { "x-immutable-cache-metadata": encodeURIComponent("{}") }
      })
    const error = failureOf(await exitOf(get(blob), over(answering(broken))))
    expect(error).toMatchObject({ operation: "get", reason: "failed", errorName: "TypeError" })
  })

  it("fails a get whose stored metadata it cannot read with corrupt", async () => {
    const headers = [
      {},
      { "x-immutable-cache-metadata": "%E0%A4%A" },
      { "x-immutable-cache-metadata": encodeURIComponent("not json") },
      { "x-immutable-cache-metadata": encodeURIComponent(JSON.stringify({ count: 1 })) },
      { "x-immutable-cache-metadata": encodeURIComponent(JSON.stringify(["a"])) }
    ]
    for (const each of headers) {
      const error = failureOf(await exitOf(get(blob), over(answering(() => new Response("x", { headers: each })))))
      expect(error).toEqual(
        new ImmutableCache.ImmutableCacheError({ backend: "fault", operation: "get", reason: "corrupt" })
      )
    }
  })
})

describe("layerWebCache", () => {
  const layer = (open: () => Promise<ImmutableCache.WebCache | undefined>) =>
    ImmutableCache.layerWebCache({ backend: "web", open, maxEntryBytes: 3 })

  it("serves over the cache it opens, with the bounds it was given", async () => {
    const result = await run(
      Effect.gen(function*() {
        return {
          stored: yield* put(blob, { bytes: utf8("abc"), metadata: {} }),
          refused: yield* put(blob, { bytes: utf8("abcd"), metadata: {} }),
          got: yield* get(blob)
        }
      }),
      layer(async () => ImmutableCache.makeMemoryWebCache())
    )
    expect([result.stored, result.refused]).toEqual(["stored", "too_large"])
    expect(new TextDecoder().decode(Option.getOrThrow(result.got).bytes)).toBe("abc")
  })

  it("fails with unavailable when there is no cache, or opening it rejects or throws", async () => {
    const opens: Array<[() => Promise<ImmutableCache.WebCache | undefined>, string | undefined]> = [
      [async () => undefined, undefined],
      [() => Promise.reject(new DOMException("insecure", "SecurityError")), "SecurityError"],
      [() => {
        throw new TypeError("caches is not defined")
      }, "TypeError"]
    ]
    for (const [open, errorName] of opens) {
      const error = failureOf(await exitOf(get(blob), layer(open)))
      expect(error).toEqual(
        new ImmutableCache.ImmutableCacheError({
          backend: "web",
          operation: "open",
          reason: "unavailable",
          ...(errorName === undefined ? {} : { errorName })
        })
      )
    }
  })
})

describe("readThrough", () => {
  const entry = { bytes: utf8("from the source"), metadata: { blobSha: "c".repeat(40) } }

  it("computes on a miss, stores, and answers the next read without computing", async () => {
    let computed = 0
    const read = ImmutableCache.readThrough(blob, Effect.sync(() => (computed += 1, entry)))
    const [first, second] = await run(Effect.all([read, read]))
    expect(computed).toBe(1)
    expect(first).toBe(entry)
    expect([...second.bytes]).toEqual([...entry.bytes])
    expect(second.metadata).toEqual(entry.metadata)
  })

  it("never stores a failure: the failure reaches the caller and the next read computes again", async () => {
    let attempts = 0
    const read = ImmutableCache.readThrough(
      blob,
      Effect.suspend(() => (attempts += 1) === 1 ? Effect.fail("capacity" as const) : Effect.succeed(entry))
    )
    const [first, second] = await run(Effect.all([Effect.exit(read), read]))
    expect(failureOf(first)).toBe("capacity")
    expect(second).toBe(entry)
    expect(attempts).toBe(2)
  })

  it("answers an entry over the bounds without storing it", async () => {
    let computed = 0
    const read = ImmutableCache.readThrough(blob, Effect.sync(() => (computed += 1, entry)))
    await run(Effect.all([read, read]), ImmutableCache.layerMemory({ maxEntryBytes: 1 }))
    expect(computed).toBe(2)
  })

  it("reads through a cache that fails, with one warning per failed call naming no key part", async () => {
    const t = telemetry()
    const backend: ImmutableCache.WebCache = {
      match: () => Promise.reject(new DOMException("x", "InvalidStateError")),
      put: () => Promise.reject(new Error("y"))
    }
    const answer = await Effect.runPromise(
      t.provide(Effect.provide(ImmutableCache.readThrough(blob, Effect.succeed(entry)), over(backend)))
    )
    expect(answer).toBe(entry)
    expect(t.logs.map((log) => [log.message, log.annotations])).toEqual([
      [["immutable cache call failed; reading through"], {
        backend: "fault",
        namespace: "repo.blob",
        operation: "get",
        reason: "failed",
        "error.type": "InvalidStateError"
      }],
      [["immutable cache call failed; reading through"], {
        backend: "fault",
        namespace: "repo.blob",
        operation: "put",
        reason: "failed",
        "error.type": "Error"
      }]
    ])
  })

  it("warns without an error type when the backend threw no named error", async () => {
    const t = telemetry()
    const backend: ImmutableCache.WebCache = { match: () => Promise.reject("no name"), put: async () => undefined }
    await Effect.runPromise(
      t.provide(Effect.provide(ImmutableCache.readThrough(blob, Effect.succeed(entry)), over(backend)))
    )
    expect(t.logs[0]?.annotations).toEqual({
      backend: "fault",
      namespace: "repo.blob",
      operation: "get",
      reason: "failed"
    })
  })
})

describe("telemetry", () => {
  it("counts every call by outcome and the bytes it moved, in spans that name no key part or content", async () => {
    const t = telemetry()
    await Effect.runPromise(t.provide(Effect.provide(
      Effect.gen(function*() {
        yield* get(blob)
        yield* put(blob, { bytes: utf8("private content"), metadata: { note: "private metadata" } })
        yield* get(blob)
        yield* put(blob, { bytes: utf8("far too large for the bound"), metadata: {} })
      }),
      ImmutableCache.layerMemory({ maxEntryBytes: 20 })
    )))
    const labels = { backend: "memory", namespace: "repo.blob" }
    expect(t.count(ImmutableCache.requests, { ...labels, operation: "get", outcome: "miss" })).toBe(1)
    expect(t.count(ImmutableCache.requests, { ...labels, operation: "get", outcome: "hit" })).toBe(1)
    expect(t.count(ImmutableCache.requests, { ...labels, operation: "put", outcome: "stored" })).toBe(1)
    expect(t.count(ImmutableCache.requests, { ...labels, operation: "put", outcome: "too_large" })).toBe(1)
    expect(t.count(ImmutableCache.bytes, { ...labels, operation: "get" })).toBe(15)
    expect(t.count(ImmutableCache.bytes, { ...labels, operation: "put" })).toBe(15)

    expect(t.spans.map((span) => [span.name, Object.fromEntries(span.attributes)])).toEqual([
      ["ImmutableCache.get", { ...prefixed(labels), "immutable_cache.outcome": "miss", "immutable_cache.bytes": 0 }],
      ["ImmutableCache.put", { ...prefixed(labels), "immutable_cache.outcome": "stored", "immutable_cache.bytes": 15 }],
      ["ImmutableCache.get", { ...prefixed(labels), "immutable_cache.outcome": "hit", "immutable_cache.bytes": 15 }],
      ["ImmutableCache.put", {
        ...prefixed(labels),
        "immutable_cache.outcome": "too_large",
        "immutable_cache.bytes": 0
      }]
    ])
    const recorded = t.recorded()
    for (const secret of [secretPath, "acme/widgets", "a".repeat(40), "private content", "private metadata"]) {
      expect(recorded).not.toContain(secret)
    }
  })

  it("counts a refused call as failed and an abandoned one as interrupted", async () => {
    const t = telemetry()
    let started!: () => void
    const waiting = new Promise<void>((resolve) => (started = resolve))
    const backend: ImmutableCache.WebCache = {
      match: () => {
        started()
        return new Promise(() => undefined)
      },
      put: () => Promise.reject(new Error("refused"))
    }
    await Effect.runPromise(t.provide(Effect.provide(
      Effect.gen(function*() {
        yield* Effect.exit(put(blob, { bytes: utf8("x"), metadata: {} }))
        const fiber = yield* Effect.forkChild(get(blob))
        yield* Effect.promise(() => waiting)
        yield* Fiber.interrupt(fiber)
      }),
      over(backend)
    )))
    const labels = { backend: "fault", namespace: "repo.blob" }
    expect(t.recorded()).not.toContain(secretPath)
    expect(t.count(ImmutableCache.requests, { ...labels, operation: "put", outcome: "failed" })).toBe(1)
    expect(t.count(ImmutableCache.requests, { ...labels, operation: "get", outcome: "interrupted" })).toBe(1)
    expect(t.count(ImmutableCache.bytes, { ...labels, operation: "put" })).toBe(0)
  })
})

const prefixed = (labels: { readonly backend: string; readonly namespace: string }) => ({
  "immutable_cache.backend": labels.backend,
  "immutable_cache.namespace": labels.namespace
})
