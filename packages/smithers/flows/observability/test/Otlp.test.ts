import { describe, expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Metric from "effect/Metric"
import * as OtlpExporter from "effect/observability/OtlpExporter"
import * as References from "effect/References"
import { TestClock } from "effect/testing"
import { readFileSync } from "node:fs"
import { Otlp, Resource } from "../src/index.ts"
import { effectVersion } from "./fixtures/effectVersion.ts"
import { boundaryResources, resourceBytes, sdkResourceBytes } from "./fixtures/resources.ts"

interface RecordedRequest {
  readonly url: string
  readonly body: unknown
  readonly headers: globalThis.Headers
}

/** A `fetch` stand-in that records every export request and never networks. */
const recordingFetch = (
  respond: () => Promise<Response> = () => Promise.resolve(new Response("{}", { status: 200 }))
) => {
  const requests: Array<RecordedRequest> = []
  const fetch: typeof globalThis.fetch = (input, init) => {
    const body = typeof init?.body === "string"
      ? init.body
      : new TextDecoder().decode(init?.body as Uint8Array)
    requests.push({
      url: String(input),
      body: JSON.parse(body),
      headers: new globalThis.Headers(init?.headers)
    })
    return respond()
  }
  return { requests, fetch }
}

/** Runs `effect` under the layer with a fresh registry and the recording fetch. */
const runExporting = <A, E>(
  effect: Effect.Effect<A>,
  layer: Layer.Layer<never, E>,
  fetch: typeof globalThis.fetch
) =>
  effect.pipe(
    Effect.provide(layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.provideService(Metric.MetricRegistry, new Map())
  )

/** The same export harness under a controllable clock, for retry assertions. */
const runExportingTimed = <A, E, R>(
  effect: Effect.Effect<A, never, R>,
  layer: Layer.Layer<R, E>,
  fetch: typeof globalThis.fetch
) =>
  effect.pipe(
    Effect.provide(layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.provideService(Metric.MetricRegistry, new Map()),
    Effect.provide(TestClock.layer())
  )

interface ExportedSpan {
  readonly name: string
  readonly status: { readonly code: number; readonly message?: string }
  readonly attributes: ReadonlyArray<{ readonly key: string; readonly value: Record<string, unknown> }>
}

/** Every span the collector received, in export order. */
const exportedSpans = (requests: ReadonlyArray<RecordedRequest>): ReadonlyArray<ExportedSpan> =>
  requests.filter((request) => request.url.endsWith("/v1/traces")).flatMap((request) =>
    (request.body as {
      readonly resourceSpans: ReadonlyArray<{
        readonly scopeSpans: ReadonlyArray<{ readonly spans: ReadonlyArray<ExportedSpan> }>
      }>
    }).resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans))
  )

/** Lets the recording transport's promises settle between clock adjustments. */
const settle = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))

const resourceAttributes = (request: RecordedRequest): Record<string, unknown> => {
  const body = request.body as {
    readonly resourceMetrics: ReadonlyArray<{
      readonly resource: { readonly attributes: ReadonlyArray<{ key: string; value: { stringValue: string } }> }
    }>
  }
  return Object.fromEntries(
    body.resourceMetrics[0]!.resource.attributes.map((attribute) => [attribute.key, attribute.value.stringValue])
  )
}

describe("Otlp", () => {
  it("keeps defaultServiceVersion equal to the package release version", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as { readonly version: string }

    expect(Otlp.defaultServiceVersion).toBe(manifest.version)
  })

  it.effect("exports registered metrics to the collector with flows resource defaults", () =>
    Effect.gen(function*() {
      const collector = recordingFetch()
      const counter = Metric.counter("observability_test_events")
      yield* runExporting(
        Metric.update(counter, 3),
        Otlp.layerFetch({ baseUrl: "http://collector.invalid:4318" }),
        collector.fetch
      )
      const exports = collector.requests.filter((request) => request.url.endsWith("/v1/metrics"))
      expect(exports.length).toBeGreaterThan(0)
      expect(JSON.stringify(exports[0]!.body)).toContain("observability_test_events")
      const attributes = resourceAttributes(exports[0]!)
      expect(attributes["service.name"]).toBe(Otlp.defaultServiceName)
      expect(attributes["service.version"]).toBe(Otlp.defaultServiceVersion)
    }))

  // The shape `docs/guides/export-to-a-collector.md` tells an operator to expect.
  it.effect("exports the documented resource, scope, log record and metric shapes", () =>
    Effect.gen(function*() {
      const collector = recordingFetch()
      yield* runExporting(
        Effect.gen(function*() {
          yield* Effect.logWarning("shape record", Cause.fail(new Error("shape cause"))).pipe(
            Effect.annotateLogs({ phase: "shape" }),
            Effect.withLogSpan("shape-log-span")
          )
          yield* Effect.void.pipe(Effect.withSpan("shape-span"))
          yield* Metric.update(Metric.timer("shape_timer"), Duration.millis(12))
          yield* Metric.update(Metric.histogram("shape_histogram", { boundaries: [1, 10, 100] }), 500)
        }),
        Otlp.layerFetch({
          baseUrl: "https://collector.invalid:4318",
          serviceName: "shape",
          attributes: { "deployment.environment.name": "test" },
          headers: { "user-agent": "shape-host/1" },
          exportInterval: "1 hour"
        }),
        collector.fetch
      ).pipe(Effect.provide(Logger.layer([])))

      interface Attribute {
        readonly key: string
        readonly value: Record<string, unknown>
      }
      interface Group {
        readonly resource: { readonly attributes: ReadonlyArray<Attribute> }
        readonly scopeLogs?: ReadonlyArray<{
          readonly scope: unknown
          readonly logRecords: ReadonlyArray<{ readonly attributes: ReadonlyArray<Attribute> }>
        }>
        readonly scopeSpans?: ReadonlyArray<{ readonly scope: unknown }>
        readonly scopeMetrics?: ReadonlyArray<{
          readonly scope: unknown
          readonly metrics: ReadonlyArray<{
            readonly name: string
            readonly unit: string
            readonly histogram: { readonly dataPoints: ReadonlyArray<Record<string, unknown>> }
          }>
        }>
      }
      const signal = (name: "Logger" | "Metrics" | "Tracer"): Group => {
        const request = collector.requests.find((candidate) =>
          candidate.url.endsWith(`/v1/${name === "Logger" ? "logs" : name === "Metrics" ? "metrics" : "traces"}`)
        )!
        expect(request.headers.get("user-agent")).toBe(
          `shape-host/1 OTel-OTLP-Exporter-JavaScript-Effect-Otlp${name}/${effectVersion}`
        )
        const group = Object.values(request.body as Record<string, ReadonlyArray<Group>>)[0]![0]!
        expect(group.resource.attributes.map((attribute) => [attribute.key, attribute.value.stringValue])).toEqual([
          ["telemetry.sdk.name", "effect"],
          ["telemetry.sdk.language", "nodejs"],
          ["telemetry.sdk.version", effectVersion],
          ["deployment.environment.name", "test"],
          ["service.name", "shape"],
          ["service.version", Otlp.defaultServiceVersion]
        ])
        return group
      }

      const logs = signal("Logger").scopeLogs![0]!
      expect(logs.scope).toEqual({ name: "effect", version: effectVersion })
      const record = Object.fromEntries(
        logs.logRecords[0]!.attributes.map((attribute) => [attribute.key, attribute.value])
      )
      expect(Object.keys(record).sort()).toEqual([
        "effect.fiberId",
        "effect.log_span.shape-log-span",
        "exception.message",
        "exception.stacktrace",
        "exception.type",
        "phase"
      ])
      expect(record.phase).toEqual({ stringValue: "shape" })
      expect(record["effect.fiberId"]!.intValue).toBeTypeOf("number")
      expect(record["effect.log_span.shape-log-span"]!.intValue).toBeTypeOf("number")
      expect(record["exception.type"]).toEqual({ stringValue: "Error" })
      expect(record["exception.message"]).toEqual({ stringValue: "shape cause" })
      expect(record["exception.stacktrace"]!.stringValue).toContain("shape cause")

      expect(signal("Tracer").scopeSpans![0]!.scope).toEqual({ name: "effect", version: effectVersion })

      const metrics = signal("Metrics").scopeMetrics![0]!
      expect(metrics.scope).toEqual({ name: "shape" })
      expect(metrics.metrics.find((metric) => metric.name === "shape_timer")!.unit).toBe("ms")
      expect(metrics.metrics.find((metric) => metric.name === "shape_histogram")!.histogram.dataPoints[0])
        .toMatchObject({
          explicitBounds: [1, 10, 100],
          bucketCounts: [0, 0, 0, 1]
        })
    }))

  it.effect("preserves a collector base path for every signal and sends auth in headers", () =>
    Effect.gen(function*() {
      const collector = recordingFetch()
      yield* runExporting(
        Effect.gen(function*() {
          yield* Effect.void.pipe(Effect.withSpan("base-path-span"))
          yield* Effect.logInfo("base path record")
          yield* Metric.update(Metric.counter("base_path_metric"), 1)
        }),
        Otlp.layerFetch({
          baseUrl: "https://collector.invalid:4318/tenant/9//",
          headers: { authorization: "Bearer synthetic-test-token" }
        }),
        collector.fetch
      )
      expect([...new Set(collector.requests.map((request) => new URL(request.url).pathname))].sort()).toEqual([
        "/tenant/9/v1/logs",
        "/tenant/9/v1/metrics",
        "/tenant/9/v1/traces"
      ])
      for (const request of collector.requests) {
        expect(request.headers.get("authorization")).toBe("Bearer synthetic-test-token")
        expect(new URL(request.url).search).toBe("")
        expect(new URL(request.url).hash).toBe("")
      }
    }))

  it.effect("prefers the caller's service identity and resource attributes", () =>
    Effect.gen(function*() {
      const collector = recordingFetch()
      yield* runExporting(
        Metric.update(Metric.counter("observability_test_identity"), 1),
        Otlp.layerFetch({
          baseUrl: "http://collector.invalid:4318",
          serviceName: "my-harness",
          serviceVersion: "9.9.9",
          attributes: { "deployment.environment.name": "test" },
          exportInterval: "1 hour",
          shutdownTimeout: "1 second"
        }),
        collector.fetch
      )
      const exports = collector.requests.filter((request) => request.url.endsWith("/v1/metrics"))
      const attributes = resourceAttributes(exports[0]!)
      expect(attributes["service.name"]).toBe("my-harness")
      expect(attributes["service.version"]).toBe("9.9.9")
      expect(attributes["deployment.environment.name"]).toBe("test")
    }))

  it.effect("sends caller headers and a non-empty metric payload through layer directly", () =>
    Effect.gen(function*() {
      const collector = recordingFetch()
      const directLayer = Otlp.layer({
        baseUrl: "https://collector.invalid:4318",
        serviceName: "direct-http-client",
        headers: {
          authorization: "Bearer test-token",
          "x-tenant": "judge-suite"
        }
      }).pipe(Layer.provide(FetchHttpClient.layer))

      yield* runExporting(
        Metric.update(Metric.counter("observability_direct_metric"), 7),
        directLayer,
        collector.fetch
      )

      const request = collector.requests.find((candidate) => candidate.url.endsWith("/v1/metrics"))
      expect(request).toBeDefined()
      expect(request?.headers.get("authorization")).toBe("Bearer test-token")
      expect(request?.headers.get("x-tenant")).toBe("judge-suite")
      expect(resourceAttributes(request!)["service.name"]).toBe("direct-http-client")
      const body = request?.body as {
        readonly resourceMetrics?: ReadonlyArray<{
          readonly scopeMetrics?: ReadonlyArray<{ readonly metrics?: ReadonlyArray<unknown> }>
        }>
      }
      expect(body.resourceMetrics?.[0]?.scopeMetrics?.[0]?.metrics?.length).toBeGreaterThan(0)
      expect(JSON.stringify(body)).toContain("observability_direct_metric")
    }))

  it.effect.each([
    {
      label: "an HTTP 500",
      respond: () => Promise.resolve(new Response("collector failed", { status: 500 }))
    },
    {
      label: "a rejected fetch",
      respond: () => Promise.reject(new TypeError("network down"))
    }
  ])("degrades on $label without failing the app or leaking a rejection", ({ respond }) =>
    Effect.gen(function*() {
      const collector = recordingFetch(respond)
      const unhandled: Array<unknown> = []
      const onUnhandled = (reason: unknown) => {
        unhandled.push(reason)
      }
      process.on("unhandledRejection", onUnhandled)
      try {
        const result = yield* runExportingTimed(
          Effect.gen(function*() {
            yield* Effect.void.pipe(Effect.withSpan("observability_failed_export"))
            // One initial request plus the three transient retries completes by
            // four seconds. The exporter then disables itself for 60 seconds.
            yield* TestClock.adjust("5 seconds")
            yield* Effect.void.pipe(Effect.withSpan("observability_dropped_while_disabled"))
            yield* TestClock.adjust("5 seconds")
            return "application-completed"
          }),
          Otlp.layerFetch({
            baseUrl: "http://collector.invalid:4318",
            exportInterval: "1 second",
            shutdownTimeout: "1 second"
          }),
          collector.fetch
        )
        yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))

        expect(result).toBe("application-completed")
        expect(unhandled).toEqual([])
        const traceRequests = collector.requests.filter((request) => request.url.endsWith("/v1/traces"))
        expect(traceRequests).toHaveLength(4)
        expect(JSON.stringify(traceRequests[0]?.body)).toContain("observability_failed_export")
        expect(JSON.stringify(traceRequests)).not.toContain("observability_dropped_while_disabled")
      } finally {
        process.off("unhandledRejection", onUnhandled)
      }
    }))

  it.effect("posts every signal below the configured base URL", () =>
    Effect.gen(function*() {
      const collector = recordingFetch()
      yield* runExporting(
        Effect.log("an exported line"),
        Otlp.layerFetch({ baseUrl: "http://collector.invalid:4318/nested" }),
        collector.fetch
      )
      for (const request of collector.requests) {
        expect(request.url).toMatch(/^http:\/\/collector\.invalid:4318\/nested\/v1\/(logs|metrics|traces)$/)
      }
      expect(collector.requests.some((request) => request.url.endsWith("/v1/logs"))).toBe(true)
    }))

  it.effect("bounds stalled exports, counts lost batches, and aborts requests before scope close", () =>
    Effect.gen(function*() {
      let started = 0
      let active = 0
      let peak = 0
      let aborted = 0
      let healthy = false
      const pending = new Set<() => void>()
      const activeCounts: Array<number> = []
      const stalledFetch: typeof globalThis.fetch = (input, init) => {
        if (healthy || String(input).endsWith("/v1/metrics")) return Promise.resolve(new Response("{}"))
        started++
        active++
        peak = Math.max(peak, active)
        return new Promise((_resolve, reject) => {
          const abort = () => {
            pending.delete(abort)
            active--
            aborted++
            reject(new DOMException("aborted", "AbortError"))
          }
          pending.add(abort)
          if (init?.signal?.aborted) abort()
          else init?.signal?.addEventListener("abort", abort, { once: true })
        })
      }
      const dropped = Metric.counter("flows_observability_otlp_dropped")
      const snapshots = yield* runExportingTimed(
        Effect.gen(function*() {
          for (let batch = 0; batch < 20; batch++) {
            for (let record = 0; record < 1000; record++) {
              if (batch < 10) yield* Effect.logInfo("synthetic record")
              else yield* Effect.void.pipe(Effect.withSpan("synthetic span"))
            }
            yield* TestClock.adjust("1 millis")
            activeCounts.push(active)
          }
          const saturated = { started, peak, dropped: (yield* Metric.value(dropped)).count }
          yield* TestClock.adjust("10 seconds")
          const timedOut = { active, aborted, dropped: (yield* Metric.value(dropped)).count }
          // A timed-out request releases its slot while the layer stays alive.
          for (let record = 0; record < 1000; record++) yield* Effect.logInfo("after timeout")
          yield* TestClock.adjust("1 millis")
          const restarted = started
          yield* TestClock.adjust("10 seconds")
          const reused = { active, aborted }
          // Clean up even with the regression present, so failures report the
          // observed counts instead of hanging in TestClock-backed finalizers.
          healthy = true
          for (const abort of pending) abort()
          yield* TestClock.adjust("5 seconds")
          return { saturated, timedOut, restarted, reused }
        }),
        Otlp.layerFetch({
          baseUrl: "http://collector.invalid:4318",
          exportInterval: "1 hour",
          shutdownTimeout: "10 millis"
        }),
        stalledFetch
      ).pipe(Effect.provide(Logger.layer([])))
      for (const count of activeCounts) expect(count).toBeLessThanOrEqual(4)
      expect(snapshots.saturated).toEqual({ started: 4, peak: 4, dropped: 16 })
      expect(snapshots.timedOut).toEqual({ active: 0, aborted: 4, dropped: 20 })
      expect(snapshots.restarted).toBe(5)
      expect(snapshots.reused).toEqual({ active: 0, aborted: 5 })
      expect(active).toBe(0)
    }))

  it.effect("delivers every batch to a collector that never ends its response, reading none of the body", () =>
    Effect.gen(function*() {
      let opened = 0
      let pulls = 0
      let cancelled = 0
      const logPosts: Array<string> = []
      const endlessFetch: typeof globalThis.fetch = (input, init) => {
        if (String(input).endsWith("/v1/logs")) logPosts.push(new TextDecoder().decode(init?.body as Uint8Array))
        opened++
        const body = new ReadableStream<Uint8Array>({
          // Paced, so a reader of this body fails the assertions below
          // instead of starving the event loop.
          pull(controller) {
            pulls++
            controller.enqueue(new Uint8Array(1024))
            return new Promise((resolve) => setTimeout(resolve, 1))
          },
          cancel() {
            cancelled++
          }
        }, { highWaterMark: 0 })
        init?.signal?.addEventListener("abort", () => void body.cancel(), { once: true })
        return Promise.resolve(new Response(body, { status: 200 }))
      }
      yield* runExportingTimed(
        Effect.gen(function*() {
          for (let batch = 0; batch < 3; batch++) {
            yield* Effect.logInfo(`endless-body batch ${batch}`)
            yield* TestClock.adjust("1 second")
            yield* settle
            // Each interval delivers its own batch: the one before it is not
            // still waiting on a body that never ends.
            expect(logPosts).toHaveLength(batch + 1)
            expect(logPosts[batch]).toContain(`endless-body batch ${batch}`)
          }
        }),
        Otlp.layerFetch({
          baseUrl: "http://collector.invalid:4318",
          exportInterval: "1 second",
          shutdownTimeout: "1 second"
        }),
        endlessFetch
      ).pipe(Effect.provide(Logger.layer([])))
      yield* settle
      expect(opened).toBeGreaterThanOrEqual(3)
      expect(pulls).toBe(0)
      expect(cancelled).toBe(opened)
    }))

  it.effect.each([429, 503])(
    "waits the retry-after of a %s before each of three retries, then gives the batch up",
    (status) =>
      Effect.gen(function*() {
        // Only the trace collector is busy, so no other signal is still
        // waiting out a retry when the scope closes.
        const traces: Array<string> = []
        const busyFetch: typeof globalThis.fetch = (input, init) => {
          if (!String(input).endsWith("/v1/traces")) return Promise.resolve(new Response("{}"))
          traces.push(new TextDecoder().decode(init?.body as Uint8Array))
          return Promise.resolve(new Response("try later", { status, headers: { "retry-after": "30" } }))
        }
        yield* runExportingTimed(
          Effect.gen(function*() {
            yield* Effect.void.pipe(Effect.withSpan("observability_retry_after"))
            // The interval posts the batch at one second. Without the header
            // the three retries would follow one second apart.
            for (const [elapsed, requests] of [[5, 1], [25, 1], [5, 2], [30, 3], [30, 4], [120, 4]] as const) {
              yield* TestClock.adjust(`${elapsed} seconds`)
              yield* settle
              expect(traces).toHaveLength(requests)
            }
          }),
          Otlp.layerFetch({
            baseUrl: "http://collector.invalid:4318",
            exportInterval: "1 second",
            shutdownTimeout: "1 second"
          }),
          busyFetch
        ).pipe(Effect.provide(Logger.layer([])))
        for (const body of traces) expect(body).toContain("observability_retry_after")
      })
  )

  it.effect("fails an answer that is no HTTP status without retrying it", () =>
    Effect.gen(function*() {
      const posts: Array<string> = []
      // A browser reports a refused redirect as status 0.
      const client = HttpClient.make((request, url) =>
        Effect.sync(() => {
          posts.push(url.pathname)
          return HttpClientResponse.fromWeb(request, Response.error())
        })
      )
      const result = yield* Effect.gen(function*() {
        yield* Effect.void.pipe(Effect.withSpan("observability_status_zero"))
        yield* TestClock.adjust("10 seconds")
        yield* settle
        return "application-completed"
      }).pipe(
        Effect.provide(
          Otlp.layer({
            baseUrl: "http://collector.invalid:4318",
            exportInterval: "1 second",
            shutdownTimeout: "1 second"
          }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient)(client)))
        ),
        Effect.provideService(Metric.MetricRegistry, new Map()),
        Effect.provide(TestClock.layer()),
        Effect.provide(Logger.layer([]))
      )
      expect(result).toBe("application-completed")
      expect(posts.filter((path) => path === "/v1/traces")).toHaveLength(1)
    }))

  it.effect("discards oversized serialized batches with a loss diagnostic", () =>
    Effect.gen(function*() {
      const collector = recordingFetch()
      const dropped = Metric.counter("flows_observability_otlp_dropped")
      yield* runExportingTimed(
        Effect.gen(function*() {
          yield* Effect.logInfo("x".repeat(1024 * 1024))
          yield* TestClock.adjust("2 seconds")
          expect(collector.requests.filter((request) => request.url.endsWith("/v1/logs"))).toHaveLength(0)
          expect((yield* Metric.value(dropped)).count).toBe(1)
          yield* Effect.logInfo("small batch")
          yield* TestClock.adjust("1 second")
          expect(collector.requests.filter((request) => request.url.endsWith("/v1/logs"))).toHaveLength(1)
        }),
        Otlp.layerFetch({ baseUrl: "http://collector.invalid:4318", exportInterval: "1 second" }),
        collector.fetch
      ).pipe(Effect.provide(Logger.layer([])))
    }))

  describe("a collector with limits", () => {
    const bytesOf = (request: RecordedRequest) => new TextEncoder().encode(JSON.stringify(request.body)).byteLength
    const logRecords = (request: RecordedRequest) =>
      (request.body as {
        resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<{ body: { stringValue: string } }> }> }>
      })
        .resourceLogs.flatMap((resource) => resource.scopeLogs.flatMap((scope) => scope.logRecords))
    const flushed = (effect: Effect.Effect<void>) =>
      Effect.gen(function*() {
        yield* effect
        yield* (yield* OtlpExporter.Flusher).flush
      })
    const limited = (options: Partial<Otlp.Options>) =>
      Otlp.layerFetch({ baseUrl: "http://collector.invalid:4318", exportInterval: "1 hour", ...options }).pipe(
        Layer.provideMerge(OtlpExporter.layerFlusher)
      )

    it.effect("splits a batch over the byte limit into requests under it, every record delivered once, in order", () =>
      Effect.gen(function*() {
        const collector = recordingFetch()
        yield* runExportingTimed(
          flushed(
            Effect.forEach(
              Array.from({ length: 400 }, (_, n) => n),
              (n) => Effect.logInfo(`record ${n} ${"x".repeat(1_000)}`),
              { discard: true }
            )
          ),
          limited({ maxRequestBytes: 128 * 1024 }),
          collector.fetch
        ).pipe(Effect.provide(Logger.layer([])))
        const logs = collector.requests.filter((request) => request.url.endsWith("/v1/logs"))
        expect(logs.length).toBeGreaterThan(2)
        for (const request of logs) expect(bytesOf(request)).toBeLessThanOrEqual(128 * 1024)
        expect(logs.flatMap(logRecords).map((record) => record.body.stringValue.split(" ")[1])).toEqual(
          Array.from({ length: 400 }, (_, n) => String(n))
        )
      }))

    it.effect("splits spans over the record limit, keeping each span's resource and scope", () =>
      Effect.gen(function*() {
        const collector = recordingFetch()
        yield* runExportingTimed(
          flushed(
            Effect.forEach(
              Array.from({ length: 450 }, (_, n) => n),
              (n) => Effect.void.pipe(Effect.withSpan(`span ${n}`)),
              { discard: true }
            )
          ),
          limited({ maxRecords: 200, serviceName: "limited" }),
          collector.fetch
        )
        const traces = collector.requests.filter((request) => request.url.endsWith("/v1/traces"))
        expect(traces.map((request) => exportedSpans([request]).length)).toEqual([200, 200, 50])
        expect(exportedSpans(traces).map((span) => span.name)).toEqual(
          Array.from({ length: 450 }, (_, n) => `span ${n}`)
        )
        for (const request of traces) {
          expect(JSON.stringify(request.body)).toContain("\"limited\"")
        }
      }))

    it.effect("spreads one metric's data points over requests and merges neighbours back into one metric", () =>
      Effect.gen(function*() {
        const collector = recordingFetch()
        yield* runExportingTimed(
          flushed(
            Effect.forEach(
              Array.from({ length: 250 }, (_, n) => n),
              (n) => Metric.update(Metric.withAttributes(Metric.counter("limited_points"), { n: String(n) }), 1),
              {
                discard: true
              }
            )
          ),
          limited({ maxRecords: 100 }),
          collector.fetch
        )
        const metrics = collector.requests.filter((request) => request.url.endsWith("/v1/metrics"))
        // Each export is a snapshot of every series, so the flush and the shutdown each send all 250 points.
        const points = metrics.map((request) =>
          (request.body as {
            resourceMetrics: Array<
              {
                scopeMetrics: Array<{
                  metrics: Array<{
                    name: string
                    sum?: { dataPoints: Array<{ attributes: Array<{ key: string; value: { stringValue: string } }> }> }
                  }>
                }>
              }
            >
          }).resourceMetrics.flatMap((resource) =>
            resource.scopeMetrics.flatMap((scope) => scope.metrics.filter((metric) => metric.name === "limited_points"))
          )
        )
        for (const metricsIn of points) {
          expect(metricsIn.length).toBeLessThanOrEqual(1)
          expect(metricsIn[0]?.sum!.dataPoints.length ?? 0).toBeLessThanOrEqual(100)
        }
        const series = points.flat().flatMap((metric) => metric.sum!.dataPoints).map((point) =>
          point.attributes.find((attribute) => attribute.key === "n")!.value.stringValue
        )
        expect(new Set(series).size).toBe(250)
      }))

    it.effect("discards only a record too large for any request, and counts it", () =>
      Effect.gen(function*() {
        const collector = recordingFetch()
        yield* runExportingTimed(
          Effect.gen(function*() {
            yield* flushed(Effect.gen(function*() {
              yield* Effect.logInfo("before")
              yield* Effect.logInfo("x".repeat(64 * 1024))
              yield* Effect.logInfo("after")
            }))
            expect((yield* Metric.value(Metric.counter("flows_observability_otlp_dropped"))).count).toBe(1)
          }),
          limited({ maxRequestBytes: 32 * 1024 }),
          collector.fetch
        ).pipe(Effect.provide(Logger.layer([])))
        const logs = collector.requests.filter((request) => request.url.endsWith("/v1/logs"))
        expect(logs.flatMap(logRecords).map((record) => record.body.stringValue)).toEqual(["before", "after"])
      }))

    it.effect("answers a refused part for the whole batch, so the exporter sends it again", () =>
      Effect.gen(function*() {
        let answered = 0
        const collector = recordingFetch(() =>
          Promise.resolve(new Response(null, { status: answered++ === 1 ? 503 : 200 }))
        )
        yield* runExportingTimed(
          Effect.gen(function*() {
            yield* Effect.forEach(Array.from({ length: 5 }, (_, n) => n), (n) => Effect.logInfo(`record ${n}`), {
              discard: true
            })
            yield* TestClock.adjust("1 second")
            yield* TestClock.adjust("10 seconds")
          }),
          Otlp.layerFetch({ baseUrl: "http://collector.invalid:4318", exportInterval: "1 second", maxRecords: 3 }),
          collector.fetch
        ).pipe(Effect.provide(Logger.layer([])))
        const delivered = collector.requests.filter((request) => request.url.endsWith("/v1/logs")).map((request) =>
          logRecords(request).map((record) => record.body.stringValue)
        )
        expect(delivered.slice(0, 2)).toEqual([["record 0", "record 1", "record 2"], ["record 3", "record 4"]])
        expect(delivered.flat()).toEqual(expect.arrayContaining(["record 3", "record 4"]))
        expect(delivered.length).toBeGreaterThan(2)
      }))
  })

  it.effect.each(boundaryResources)(
    "exports every signal with a resource at the byte boundary: $serviceName",
    (configuration) =>
      Effect.gen(function*() {
        const collector = recordingFetch()
        expect(sdkResourceBytes(configuration)).toBe(Resource.maximumResourceBytes)
        expect(resourceBytes(configuration)).toBeLessThanOrEqual(Resource.maximumResourceBytes)
        yield* runExporting(
          Effect.gen(function*() {
            yield* Effect.logInfo("small log")
            yield* Effect.void.pipe(Effect.withSpan("small span"))
            yield* Metric.update(Metric.counter("boundary/small_metric"), 1)
          }),
          Otlp.layerFetch({ baseUrl: "http://collector.invalid:4318", ...configuration, exportInterval: "1 hour" }),
          collector.fetch
        ).pipe(
          // Ambient resource data must never enlarge the accepted resource.
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
            OTEL_RESOURCE_ATTRIBUTES: { ambient: "x".repeat(Otlp.maxRequestBytes) }
          })))
        )
        expect(collector.requests.map((request) => request.url.split("/").at(-1)).sort()).toEqual([
          "logs",
          "metrics",
          "traces"
        ])
        for (const request of collector.requests) {
          const bytes = new TextEncoder().encode(JSON.stringify(request.body)).byteLength
          expect(bytes).toBeLessThanOrEqual(Otlp.maxRequestBytes - Otlp.reservedBatchBytes + 4_096)
          expect(JSON.stringify(request.body)).not.toContain("ambient")
        }
      })
  )

  it.effect("reserves enough room for ordinary 1,000-record log and span batches", () =>
    Effect.gen(function*() {
      const collector = recordingFetch()
      yield* runExportingTimed(
        Effect.gen(function*() {
          for (let i = 0; i < 1_000; i++) yield* Effect.logInfo("ordinary log record")
          yield* TestClock.adjust("1 millis")
          for (let i = 0; i < 1_000; i++) yield* Effect.void.pipe(Effect.withSpan("ordinary span"))
          yield* TestClock.adjust("1 millis")
          expect((yield* Metric.value(Metric.counter("flows_observability_otlp_dropped"))).count).toBe(0)
        }),
        Otlp.layerFetch({
          baseUrl: "http://collector.invalid:4318",
          ...boundaryResources[3]!,
          exportInterval: "1 hour"
        }),
        collector.fetch
      )
      const logs = collector.requests.find((request) => request.url.endsWith("/logs"))!
      const traces = collector.requests.find((request) => request.url.endsWith("/traces"))!
      expect(
        (logs.body as { resourceLogs: Array<{ scopeLogs: Array<{ logRecords: unknown[] }> }> }).resourceLogs[0]!
          .scopeLogs[0]!.logRecords
      ).toHaveLength(1_000)
      expect(
        (traces.body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }> }).resourceSpans[0]!
          .scopeSpans[0]!.spans
      ).toHaveLength(1_000)
      for (const request of [logs, traces]) {
        expect(new TextEncoder().encode(JSON.stringify(request.body)).byteLength).toBeLessThan(Otlp.maxRequestBytes)
      }
    }))

  it.effect("warns through the acquisition loggers, rate limits loss and never exports its own diagnostic", () =>
    Effect.gen(function*() {
      const collector = recordingFetch()
      const warnings: Array<
        {
          level: string
          message: unknown
          annotations: Readonly<Record<string, unknown>>
          spans: ReadonlyArray<readonly [string, number]>
        }
      > = []
      const ambient = Logger.make((options) => {
        if (options.logLevel === "Warn") {
          warnings.push({
            level: options.logLevel,
            message: options.message,
            annotations: options.fiber.getRef(References.CurrentLogAnnotations),
            spans: options.fiber.getRef(References.CurrentLogSpans)
          })
        }
      })
      yield* runExportingTimed(
        Effect.gen(function*() {
          const flusher = yield* OtlpExporter.Flusher
          for (let i = 0; i < 2; i++) {
            yield* Effect.logInfo("PRIVATE_BATCH_VALUE" + "x".repeat(Otlp.maxRequestBytes))
            yield* flusher.flush
          }
          expect(warnings).toHaveLength(1)
          expect((yield* Metric.value(Metric.counter("flows_observability_otlp_dropped"))).count).toBe(2)
          yield* TestClock.adjust("60 seconds")
          yield* Effect.logInfo("x".repeat(Otlp.maxRequestBytes))
          yield* flusher.flush
          expect(warnings).toHaveLength(2)
          expect(warnings.map((warning) => warning.annotations.dropped)).toEqual([1, 3])
          yield* Effect.logInfo("small batch after loss")
          yield* flusher.flush
        }),
        Otlp.layerFetch({ baseUrl: "http://collector.invalid:4318", exportInterval: "1 hour" }).pipe(
          Layer.provideMerge(OtlpExporter.layerFlusher)
        ),
        collector.fetch
      ).pipe(
        Effect.provide(Logger.layer([ambient])),
        Effect.annotateLogs({ private: "PRIVATE_AMBIENT_VALUE" }),
        Effect.withLogSpan("PRIVATE_LOG_SPAN")
      )
      expect(warnings[0]).toMatchObject({
        level: "Warn",
        spans: [],
        message: ["An OTLP export batch was discarded"],
        annotations: { code: "otlp_export_discarded", reason: "oversized", limit: Otlp.maxRequestBytes }
      })
      expect(warnings[0]!.annotations.bytes).toBeGreaterThan(Otlp.maxRequestBytes)
      expect(JSON.stringify(warnings)).not.toContain("PRIVATE_")
      expect(JSON.stringify(warnings).length).toBeLessThan(1_024)
      const logs = collector.requests.filter((request) => request.url.endsWith("/logs"))
      expect(logs).toHaveLength(1)
      expect(JSON.stringify(logs)).toContain("small batch after loss")
      expect(JSON.stringify(logs)).not.toContain("otlp_export_discarded")
      expect(JSON.stringify(logs)).not.toContain("An OTLP export batch was discarded")
    }))

  it.effect("layerNoop provides nothing and exports nothing", () =>
    Effect.gen(function*() {
      const collector = recordingFetch()
      yield* runExporting(Metric.update(Metric.counter("observability_test_noop"), 1), Otlp.layerNoop, collector.fetch)
      expect(collector.requests).toEqual([])
    }))

  it.effect.each(
    [
      ["unset", {}],
      ["empty", { OTEL_EXPORTER_OTLP_ENDPOINT: "" }],
      ["blank", { OTEL_EXPORTER_OTLP_ENDPOINT: "  ", OTEL_EXPORTER_OTLP_HEADERS: "x-key=value" }]
    ] as const
  )("layerEnvironment installs no exporter when the endpoint is %s", ([, environment]) =>
    Effect.gen(function*() {
      const collector = recordingFetch()
      yield* runExporting(
        Effect.void.pipe(Effect.withSpan("observability_environment_unset")),
        Otlp.layerEnvironment(environment),
        collector.fetch
      )
      expect(collector.requests).toEqual([])
    }))

  it.effect("layerEnvironment exports to the named endpoint with the environment's headers", () =>
    Effect.gen(function*() {
      const collector = recordingFetch()
      yield* runExporting(
        Effect.void.pipe(Effect.withSpan("observability_environment_span")),
        Otlp.layerEnvironment({
          OTEL_EXPORTER_OTLP_ENDPOINT: " http://127.0.0.1:4318/base ",
          OTEL_EXPORTER_OTLP_HEADERS: "x-tenant=acme%20co, x-empty="
        }, { serviceName: "smthrs" }),
        collector.fetch
      )
      const traces = collector.requests.filter((request) => request.url === "http://127.0.0.1:4318/base/v1/traces")
      expect(traces).toHaveLength(1)
      expect(traces[0]!.headers.get("x-tenant")).toBe("acme co")
      expect(traces[0]!.headers.get("x-empty")).toBe("")
      expect(JSON.stringify(traces[0]!.body)).toContain("observability_environment_span")
      expect(JSON.stringify(traces[0]!.body)).toContain("smthrs")
    }))

  it.effect("layerEnvironment refuses an invalid endpoint at acquisition", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(
        runExporting(
          Effect.void,
          Otlp.layerEnvironment({ OTEL_EXPORTER_OTLP_ENDPOINT: "not a url" }),
          recordingFetch().fetch
        )
      )
      expect(error._tag).toBe("@smthrs/observability/InvalidExporterEndpoint")
    }))

  it.effect("redacts credentials from exported span failures and string attributes", () =>
    Effect.gen(function*() {
      const collector = recordingFetch()
      const secret = "Bearer sk-ant-api03-synthetic-secret-value-0123456789"
      yield* runExporting(
        Effect.gen(function*() {
          yield* Effect.annotateCurrentSpan({ "request.auth": secret, "request.count": 3 })
          return yield* Effect.fail(new Error(`upstream refused ${secret}`))
        }).pipe(
          Effect.withSpan("observability_redacted_failure"),
          Effect.ignore,
          Effect.andThen(Effect.interrupt.pipe(Effect.withSpan("observability_interrupted"), Effect.exit)),
          Effect.andThen(Effect.void.pipe(Effect.withSpan("observability_succeeded")))
        ),
        Otlp.layerFetch({ baseUrl: "http://127.0.0.1:4318" }),
        collector.fetch
      )
      const traceRequests = collector.requests.filter((request) => request.url.endsWith("/v1/traces"))
      const traces = JSON.stringify(traceRequests)
      expect(traces).toContain("observability_redacted_failure")
      expect(traces).toContain("upstream refused")
      expect(traces).toContain("exception.stacktrace")
      expect(traces).toMatch(/exception\.type.{0,40}Error/)
      expect(traces).toContain("request.count")
      expect(traces).not.toContain("sk-ant-api03-synthetic-secret-value-0123456789")
      // Redaction rebuilds a failure and leaves the other two outcomes as they
      // were: OTLP status 2 is an error, 0 is unset and 1 is ok.
      const spans = exportedSpans(collector.requests)
      expect(spans.map((span) => [span.name, span.status])).toEqual([
        ["observability_redacted_failure", { code: 2, message: expect.stringContaining("upstream refused") }],
        ["observability_interrupted", { code: 0 }],
        ["observability_succeeded", { code: 1 }]
      ])
      expect(spans[1]!.attributes).toEqual([{ key: "effect.fiber.interrupted", value: { boolValue: true } }])
    }))

  it.effect("exports only the spans `spans` names; a dropped span's children keep its trace and parent id", () =>
    Effect.gen(function*() {
      const collector = recordingFetch()
      const ids: Record<string, { traceId: string; spanId: string }> = {}
      const record = (name: string) =>
        Effect.flatMap(Effect.currentSpan, (span) =>
          Effect.sync(() => {
            ids[name] = { traceId: span.traceId, spanId: span.spanId }
          })).pipe(Effect.orDie)
      yield* runExporting(
        record("kept_child").pipe(
          Effect.withSpan("kept_child"),
          Effect.andThen(record("dropped")),
          Effect.withSpan("dropped"),
          Effect.andThen(Effect.log("a log line is exported all the same")),
          Effect.andThen(record("kept_root")),
          Effect.withSpan("kept_root")
        ),
        Otlp.layerFetch({ baseUrl: "http://127.0.0.1:4318", spans: ["kept_root", "kept_child"] }),
        collector.fetch
      )
      const spans = exportedSpans(collector.requests) as ReadonlyArray<
        ExportedSpan & { readonly traceId: string; readonly spanId: string; readonly parentSpanId?: string }
      >
      expect(spans.map((span) => span.name).sort()).toEqual(["kept_child", "kept_root"])
      const child = spans.find((span) => span.name === "kept_child")!
      // One trace from the root, through the dropped span, to its child, which names the dropped span as its parent.
      expect(child.traceId).toBe(ids.kept_root!.traceId)
      expect(ids.dropped!.traceId).toBe(ids.kept_root!.traceId)
      expect(child.parentSpanId).toBe(ids.dropped!.spanId)
      expect(JSON.stringify(collector.requests)).toContain("a log line is exported all the same")
    }))

  // Effect's HTTP client ends the span of a 4xx or 5xx answer itself, before
  // the request's effect completes. The collector still receives it once.
  it.effect("exports one failed span, with no header, for an HTTP request the server answered 503", () =>
    Effect.gen(function*() {
      const collector = recordingFetch()
      const upstream = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(
          request,
          new Response(null, { status: 503, headers: { "set-cookie": "session=synthetic-upstream-cookie" } })
        ))
      )
      yield* runExporting(
        upstream.get("https://upstream.invalid/resource", {
          headers: { "x-upstream-token": "synthetic-upstream-token" }
        }).pipe(Effect.asVoid, Effect.orDie),
        Otlp.layerFetch({ baseUrl: "http://127.0.0.1:4318" }),
        collector.fetch
      )
      const spans = exportedSpans(collector.requests)
      expect(spans.map((span) => [span.name, span.status])).toEqual([
        ["GET", { code: 2, message: expect.stringContaining("503") }]
      ])
      const attributes = Object.fromEntries(spans[0]!.attributes.map((attribute) => [attribute.key, attribute.value]))
      expect(attributes["error.type"]).toEqual({ stringValue: "503" })
      expect(attributes["http.response.status_code"]).toEqual({ intValue: 503 })
      expect(attributes["server.address"]).toEqual({ stringValue: "upstream.invalid" })
      expect(Object.keys(attributes).filter((key) => key.startsWith("http.request.header."))).toEqual([])
      expect(Object.keys(attributes).filter((key) => key.startsWith("http.response.header."))).toEqual([])
      const exported = JSON.stringify(collector.requests)
      expect(exported).not.toContain("synthetic-upstream-token")
      expect(exported).not.toContain("synthetic-upstream-cookie")
    }))

  it("parseHeaders decodes percent escapes and skips malformed pairs", () => {
    expect(Otlp.parseHeaders(undefined)).toEqual({})
    expect(Otlp.parseHeaders("")).toEqual({})
    expect(Otlp.parseHeaders("a=1,b = two%3Dthree , novalue,=orphan,c=%E0%A4%A,d=x=y")).toEqual({
      a: "1",
      b: "two=three",
      c: "%E0%A4%A",
      d: "x=y"
    })
  })

  it.effect("applies the application policy before transport and retains final credential redaction", () =>
    Effect.gen(function*() {
      const collector = recordingFetch()
      const seen: unknown[] = []
      yield* runExporting(
        Effect.logInfo("application record"),
        Otlp.layerFetch({
          baseUrl: "http://127.0.0.1:4318",
          transform: (payload) => {
            seen.push(payload)
            return {
              ...payload as object,
              attributes: [{ key: "apiKey", value: { stringValue: "policy-must-not-bypass-redaction" } }]
            }
          }
        }),
        collector.fetch
      )
      expect(seen.length).toBeGreaterThan(0)
      expect(JSON.stringify(seen)).toContain("application record")
      expect(JSON.stringify(collector.requests)).not.toContain("policy-must-not-bypass-redaction")
      expect(JSON.stringify(collector.requests)).toContain("[REDACTED]")
    }))
})
