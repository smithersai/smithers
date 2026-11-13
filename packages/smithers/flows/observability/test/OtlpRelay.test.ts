import { describe, expect, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpEffect from "effect/http/HttpEffect"
import * as Logger from "effect/Logger"
import * as Metric from "effect/Metric"
import * as References from "effect/References"
import { Metric as FlowsMetric, Otlp, OtlpRelay } from "../src/index.ts"

interface Line {
  readonly level: string
  readonly message: unknown
  readonly annotations: Readonly<Record<string, unknown>>
}

/** `serve` as a web handler whose lines and metrics land in this relay's own sinks. */
const relay = (options?: OtlpRelay.Options) => {
  const lines: Array<Line> = []
  const registry = new Map() as Context.Service.Shape<typeof Metric.MetricRegistry>
  const logger = Logger.make<unknown, void>((log) => {
    const message = Array.isArray(log.message) && log.message.length === 1 ? log.message[0] : log.message
    lines.push({ level: log.logLevel, message, annotations: log.fiber.getRef(References.CurrentLogAnnotations) })
  })
  const context = Context.make(Logger.CurrentLoggers, new Set([logger])).pipe(
    Context.add(Metric.MetricRegistry, registry)
  )
  const handler = HttpEffect.toWebHandler(OtlpRelay.serve(options))
  const handle = (request: Request) => handler(request, context as Context.Context<never>)
  const post = (path: string, body: BodyInit) =>
    handle(new Request(`http://relay.test/api/telemetry${path}`, { method: "POST", body }))
  const count = (metric: Metric.Counter<number>, attributes: Record<string, string>) =>
    Effect.runSync(
      Metric.value(Metric.withAttributes(metric, attributes)).pipe(
        Effect.provideService(Metric.MetricRegistry, registry)
      )
    ).count
  return { lines, handle, post, count }
}

/** Runs a browser-side program whose `Otlp.layerFetch` exporter posts straight into `handle`. */
const exportThrough = (handle: (request: Request) => Promise<Response>, program: Effect.Effect<void>) =>
  program.pipe(
    Effect.provide(Otlp.layerFetch({ baseUrl: "http://relay.test/api/telemetry", serviceName: "browser" })),
    Effect.provideService(FetchHttpClient.Fetch, (input, init) => handle(new Request(input, init))),
    Effect.provideService(Metric.MetricRegistry, new Map()),
    Effect.provide(Logger.layer([])),
    Effect.orDie
  )

const bySignal = (lines: ReadonlyArray<Line>, signal: OtlpRelay.Signal) =>
  lines.filter((line) => line.annotations["otlp.signal"] === signal)

/** A chunked body that never ends on its own. */
const endless = (onPull: () => void) =>
  new ReadableStream<Uint8Array>({
    pull: (controller) => {
      onPull()
      controller.enqueue(new Uint8Array(51).fill(32))
    }
  })

describe("OtlpRelay", () => {
  it.effect("relays exporter log records with severity, trace context and flattened attributes", () =>
    Effect.gen(function*() {
      const { lines, handle, count } = relay()
      yield* exportThrough(
        handle,
        Effect.logWarning("browser says hi").pipe(
          Effect.annotateLogs({
            answerId: "answer-1",
            password: "hunter2",
            note: "Bearer abcdefghijklmnopqrstuvwxyz123456"
          }),
          Effect.withSpan("ask")
        )
      )
      const [line] = bySignal(lines, "logs")
      expect(line).toMatchObject({
        level: "Warn",
        message: "browser says hi",
        annotations: {
          "otlp.signal": "logs",
          "service.name": "browser",
          "otlp.severity": "Warn",
          answerId: "answer-1",
          note: "Bearer [REDACTED_TOKEN]"
        }
      })
      expect(line!.annotations).not.toHaveProperty("password")
      expect(line!.annotations["trace_id"]).toMatch(/^[0-9a-f]{32}$/)
      expect(line!.annotations["span_id"]).toMatch(/^[0-9a-f]{16}$/)
      const [span] = bySignal(lines, "traces")
      expect(span!.annotations["trace_id"]).toBe(line!.annotations["trace_id"])
      expect(span!.annotations["span_id"]).toBe(line!.annotations["span_id"])
      expect(count(FlowsMetric.relayedRecords, { signal: "logs" })).toBe(1)
      expect(count(FlowsMetric.relayDroppedRecords, { signal: "logs", reason: "not_allowed" })).toBe(0)
      expect(count(FlowsMetric.relayDroppedRecords, { signal: "logs", reason: "over_limit" })).toBe(0)
    }))

  it.effect("relays exporter spans with duration, parent, attributes and error status", () =>
    Effect.gen(function*() {
      const { lines, handle } = relay()
      yield* exportThrough(
        handle,
        Effect.fail("card declined").pipe(
          Effect.withSpan("charge", { attributes: { "order.id": "o-7", retries: 2 } }),
          Effect.ignore,
          Effect.withSpan("checkout")
        )
      )
      const spans = bySignal(lines, "traces")
      const charge = spans.find((line) => line.message === "charge")!
      const checkout = spans.find((line) => line.message === "checkout")!
      expect(charge.level).toBe("Error")
      expect(checkout.level).toBe("Info")
      expect(charge.annotations).toMatchObject({
        "service.name": "browser",
        "order.id": "o-7",
        retries: 2,
        trace_id: checkout.annotations["trace_id"],
        "otlp.parent_span_id": checkout.annotations["span_id"]
      })
      expect(charge.annotations["otlp.status_message"]).toContain("card declined")
      expect(charge.annotations["otlp.duration_ms"]).toBeGreaterThanOrEqual(0)
      expect(checkout.annotations).not.toHaveProperty("otlp.parent_span_id")
    }))

  it.effect("relays exporter metric data points with their values", () =>
    Effect.gen(function*() {
      const { lines, handle, count } = relay()
      yield* exportThrough(
        handle,
        Effect.gen(function*() {
          yield* Metric.update(Metric.withAttributes(Metric.counter("clicks"), { button: "send" }), 3)
          yield* Metric.update(Metric.gauge("latency_ratio"), 0.25)
          yield* Metric.update(Metric.histogram("answer_ms", { boundaries: [10, 100] }), 40)
        })
      )
      const metrics = bySignal(lines, "metrics")
      expect(metrics.find((line) => line.message === "clicks")!.annotations).toMatchObject({
        "service.name": "browser",
        "otlp.metric_type": "sum",
        "otlp.value": 3,
        button: "send"
      })
      expect(metrics.find((line) => line.message === "latency_ratio")!.annotations).toMatchObject({
        "otlp.metric_type": "gauge",
        "otlp.value": 0.25
      })
      expect(metrics.find((line) => line.message === "answer_ms")!.annotations).toMatchObject({
        "otlp.metric_type": "histogram",
        "otlp.count": 1,
        "otlp.sum": 40
      })
      expect(count(FlowsMetric.relayedRecords, { signal: "metrics" })).toBe(metrics.length)
    }))

  it.effect("relays a metric point whose value is not a finite number without a value, and the rest of the export", () =>
    Effect.gen(function*() {
      const { lines, handle, count } = relay()
      // JSON has no NaN or Infinity: the exporter writes such a value as the string "NaN" or "Infinity".
      yield* exportThrough(
        handle,
        Effect.gen(function*() {
          yield* Metric.update(Metric.gauge("ratio"), 0 / 0)
          yield* Metric.update(Metric.gauge("rate"), 1 / 0)
          yield* Metric.update(Metric.counter("clicks"), 1)
        })
      )
      const metrics = bySignal(lines, "metrics")
      expect(metrics.map((line) => line.message).sort()).toEqual(["clicks", "rate", "ratio"])
      expect(metrics.find((line) => line.message === "clicks")!.annotations["otlp.value"]).toBe(1)
      expect(metrics.find((line) => line.message === "ratio")!.annotations).not.toHaveProperty("otlp.value")
      expect(metrics.find((line) => line.message === "rate")!.annotations).not.toHaveProperty("otlp.value")
      expect(count(FlowsMetric.relayedRecords, { signal: "metrics" })).toBe(3)
    }))

  it("relays a data point whose value, integer or sum is not a finite number without that field", async () => {
    const { lines, post } = relay()
    const point = (fields: Record<string, unknown>) => ({ attributes: [], ...fields })
    const response = await post(
      "/v1/metrics",
      JSON.stringify({
        resourceMetrics: [{
          scopeMetrics: [{
            metrics: [
              { name: "ratio", gauge: { dataPoints: [point({ asDouble: null }), point({ asDouble: "-Infinity" })] } },
              { name: "count", sum: { dataPoints: [point({ asInt: null })] } },
              {
                name: "answer_ms",
                histogram: { dataPoints: [point({ count: 2, sum: "NaN" }), point({ count: 3, sum: null })] }
              },
              { name: "spent", gauge: { dataPoints: [point({ asDouble: "Infinity", asInt: 4 })] } }
            ]
          }]
        }]
      })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({})
    expect(lines.map(({ message, annotations }) => [message, annotations["otlp.value"], annotations["otlp.count"]]))
      .toEqual([
        ["ratio", undefined, undefined],
        ["ratio", undefined, undefined],
        ["count", undefined, undefined],
        ["answer_ms", undefined, 2],
        ["answer_ms", undefined, 3],
        ["spent", 4, undefined]
      ])
    for (const line of lines) expect(line.annotations).not.toHaveProperty("otlp.sum")
    for (const line of lines.slice(0, 5)) expect(line.annotations).not.toHaveProperty("otlp.value")
  })

  it("answers 200 with an empty JSON object", async () => {
    const response = await relay().post("/v1/logs?tenant=a", "{}")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({})
  })

  it("flattens every OTLP value kind and nested key lists", async () => {
    const { lines, post } = relay()
    const value = (v: object) => v
    await post(
      "/v1/logs",
      JSON.stringify({
        resourceLogs: [{
          scopeLogs: [{
            logRecords: [{
              attributes: [
                { key: "s", value: value({ stringValue: "x" }) },
                { key: "b", value: value({ boolValue: false }) },
                { key: "i", value: value({ intValue: "42" }) },
                { key: "d", value: value({ doubleValue: 1.5 }) },
                { key: "bytes", value: value({ bytesValue: "AAE=" }) },
                { key: "list", value: value({ arrayValue: { values: [{ intValue: 1 }, {}] } }) },
                { key: "empty", value: value({ arrayValue: {} }) },
                {
                  key: "user",
                  value: value({
                    kvlistValue: {
                      values: [{ key: "id", value: { stringValue: "u-1" } }, {
                        key: "api_key",
                        value: { stringValue: "k" }
                      }]
                    }
                  })
                },
                {
                  key: "secret",
                  value: value({ kvlistValue: { values: [{ key: "id", value: { stringValue: "s-1" } }] } })
                },
                { key: "absent" }
              ],
              body: { kvlistValue: { values: [{ key: "event", value: { stringValue: "click" } }] } }
            }, {}]
          }]
        }]
      })
    )
    const [first, second] = lines
    expect(first!.message).toEqual({ event: "click" })
    expect(first!.annotations).toEqual({
      s: "x",
      b: false,
      i: 42,
      d: 1.5,
      bytes: "AAE=",
      list: [1, undefined],
      empty: [],
      "user.id": "u-1",
      absent: undefined,
      "otlp.signal": "logs"
    })
    expect(second).toEqual({ level: "Info", message: "", annotations: { "otlp.signal": "logs" } })
  })

  it("logs a span without status at Info", async () => {
    const { lines, post } = relay()
    await post(
      "/v1/traces",
      JSON.stringify({
        resourceSpans: [{
          scopeSpans: [{ spans: [{ name: "idle", startTimeUnixNano: "1000000", endTimeUnixNano: 3_000_000 }] }]
        }]
      })
    )
    expect(lines).toEqual([{
      level: "Info",
      message: "idle",
      annotations: { "otlp.signal": "traces", "otlp.duration_ms": 2 }
    }])
  })

  it("maps OTLP severity to Effect log levels", async () => {
    const cases: ReadonlyArray<readonly [number | undefined, string | undefined, string]> = [
      [1, undefined, "Trace"],
      [4, undefined, "Trace"],
      [5, undefined, "Debug"],
      [9, "WARN", "Info"],
      [13, undefined, "Warn"],
      [17, undefined, "Error"],
      [21, undefined, "Fatal"],
      [24, undefined, "Fatal"],
      [30, undefined, "Fatal"],
      [0, "ERROR", "Error"],
      [undefined, "warning", "Warn"],
      [undefined, "Debug2", "Debug"],
      [undefined, "verbose", "Info"],
      [undefined, undefined, "Info"]
    ]
    for (const [number, text, level] of cases) expect(OtlpRelay.severityLevel(number, text)).toBe(level)

    const { lines, post } = relay()
    await post(
      "/v1/logs",
      JSON.stringify({
        resourceLogs: [{ scopeLogs: [{ logRecords: [{ severityNumber: 18, body: { stringValue: "boom" } }] }] }]
      })
    )
    expect(lines).toEqual([{
      level: "Error",
      message: "boom",
      annotations: { "otlp.signal": "logs", "otlp.severity": 18 }
    }])
  })

  it("relays at most maxRecords records and counts the rest", async () => {
    const { lines, post, count } = relay({ maxRecords: 2 })
    const record = { body: { stringValue: "r" } }
    const response = await post(
      "/v1/logs",
      JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [record, record, record] }] }] })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      partialSuccess: { rejectedLogRecords: 1, errorMessage: "relayed the first 2 records" }
    })
    expect(lines).toHaveLength(2)
    expect(count(FlowsMetric.relayedRecords, { signal: "logs" })).toBe(2)
    expect(count(FlowsMetric.relayDroppedRecords, { signal: "logs", reason: "over_limit" })).toBe(1)
    expect(count(FlowsMetric.relayDroppedRecords, { signal: "logs", reason: "not_allowed" })).toBe(0)
  })

  it("redacts the finished line: the message, the attributes and the fields the relay adds", async () => {
    const secret = "SENTINEL0relay0secret0value"
    const token = `Bearer ${secret}`
    const resource = { attributes: [{ key: "service.name", value: { stringValue: `web ${token}` } }] }
    const { lines, post } = relay()
    await post(
      "/v1/logs",
      JSON.stringify({
        resourceLogs: [{
          resource,
          scopeLogs: [{
            logRecords: [{
              body: { stringValue: `sign-in failed: ${token}` },
              attributes: [{ key: "note", value: { stringValue: token } }]
            }]
          }]
        }]
      })
    )
    await post(
      "/v1/traces",
      JSON.stringify({
        resourceSpans: [{
          resource,
          scopeSpans: [{ spans: [{ name: `fetch ${token}`, status: { code: 2, message: `provider said ${token}` } }] }]
        }]
      })
    )
    expect(lines).toHaveLength(2)
    expect(JSON.stringify(lines)).not.toContain(secret)
    const [log, span] = lines
    expect(log).toMatchObject({
      message: "sign-in failed: Bearer [REDACTED_TOKEN]",
      annotations: { note: "Bearer [REDACTED_TOKEN]", "service.name": "web Bearer [REDACTED_TOKEN]" }
    })
    expect(span).toMatchObject({
      level: "Error",
      message: "fetch Bearer [REDACTED_TOKEN]",
      annotations: {
        "service.name": "web Bearer [REDACTED_TOKEN]",
        "otlp.status_message": "provider said Bearer [REDACTED_TOKEN]"
      }
    })
  })

  it("relays only the records and fields an allowlist names, and counts what it drops", async () => {
    const { lines, post, count } = relay({
      allow: {
        records: ["chat ready", "chat.ask", "clicks"],
        fields: ["otlp.signal", "trace_id", "answerId", "user.id", "password", "otlp.value"]
      }
    })
    const attributes = [
      { key: "answerId", value: { stringValue: "a-1" } },
      { key: "question", value: { stringValue: "what is the content?" } },
      { key: "password", value: { stringValue: "hunter2" } },
      { key: "user", value: { kvlistValue: { values: [{ key: "id", value: { stringValue: "u-1" } }] } } }
    ]
    const resource = { attributes: [{ key: "service.name", value: { stringValue: "web" } }] }
    const logs = await post(
      "/v1/logs",
      JSON.stringify({
        resourceLogs: [{
          resource,
          scopeLogs: [{
            logRecords: [
              { body: { stringValue: "chat ready" }, attributes, traceId: "t".repeat(32), severityText: "Info" },
              { body: { stringValue: "question asked" }, attributes },
              { body: { kvlistValue: { values: [{ key: "event", value: { stringValue: "chat ready" } }] } } },
              {}
            ]
          }]
        }]
      })
    )
    expect(await logs.json()).toEqual({
      partialSuccess: { rejectedLogRecords: 3, errorMessage: "dropped 3 records off the allowlist" }
    })
    await post(
      "/v1/traces",
      JSON.stringify({
        resourceSpans: [{ resource, scopeSpans: [{ spans: [{ name: "chat.ask", attributes }, { name: "secret" }] }] }]
      })
    )
    await post(
      "/v1/metrics",
      JSON.stringify({
        resourceMetrics: [{
          resource,
          scopeMetrics: [{
            metrics: [
              { name: "clicks", sum: { dataPoints: [{ asInt: "3", attributes }] } },
              { name: "latency", gauge: { dataPoints: [{ asDouble: 0.5 }] } }
            ]
          }]
        }]
      })
    )
    expect(lines).toEqual([
      {
        level: "Info",
        message: "chat ready",
        annotations: { answerId: "a-1", "user.id": "u-1", "otlp.signal": "logs", trace_id: "t".repeat(32) }
      },
      {
        level: "Info",
        message: "chat.ask",
        annotations: { answerId: "a-1", "user.id": "u-1", "otlp.signal": "traces" }
      },
      {
        level: "Info",
        message: "clicks",
        annotations: { answerId: "a-1", "user.id": "u-1", "otlp.signal": "metrics", "otlp.value": 3 }
      }
    ])
    expect(count(FlowsMetric.relayedRecords, { signal: "logs" })).toBe(1)
    expect(count(FlowsMetric.relayDroppedRecords, { signal: "logs", reason: "not_allowed" })).toBe(3)
    expect(count(FlowsMetric.relayDroppedRecords, { signal: "traces", reason: "not_allowed" })).toBe(1)
    expect(count(FlowsMetric.relayDroppedRecords, { signal: "metrics", reason: "not_allowed" })).toBe(1)
    expect(count(FlowsMetric.relayDroppedRecords, { signal: "logs", reason: "over_limit" })).toBe(0)
  })

  it("caps the allowed records at maxRecords and reports both reasons", async () => {
    const { lines, post, count } = relay({ maxRecords: 2, allow: { records: ["kept"], fields: [] } })
    const kept = { body: { stringValue: "kept" } }
    const other = { body: { stringValue: "other" } }
    const response = await post(
      "/v1/logs",
      JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [other, kept, kept, other, kept] }] }] })
    )
    expect(await response.json()).toEqual({
      partialSuccess: {
        rejectedLogRecords: 3,
        errorMessage: "dropped 2 records off the allowlist; relayed the first 2 records"
      }
    })
    expect(lines).toEqual([
      { level: "Info", message: "kept", annotations: {} },
      { level: "Info", message: "kept", annotations: {} }
    ])
    expect(count(FlowsMetric.relayDroppedRecords, { signal: "logs", reason: "not_allowed" })).toBe(2)
    expect(count(FlowsMetric.relayDroppedRecords, { signal: "logs", reason: "over_limit" })).toBe(1)
  })

  it("answers 413 past maxBodyBytes, for a sized body and for a chunked body that never ends", async () => {
    const { lines, post, handle } = relay({ maxBodyBytes: 100 })
    expect((await post("/v1/logs", "x".repeat(101))).status).toBe(413)
    expect((await post("/v1/logs", "{}" + " ".repeat(98))).status).toBe(200)
    let chunks = 0
    const chunked = new Request(
      "http://relay.test/v1/traces",
      { method: "POST", body: endless(() => chunks++), duplex: "half" } as RequestInit
    )
    expect((await handle(chunked)).status).toBe(413)
    // Two chunks exceed the limit; the stream may pull one more ahead.
    expect(chunks).toBeGreaterThanOrEqual(2)
    expect(chunks).toBeLessThanOrEqual(3)
    expect(lines).toEqual([])
  })

  it("answers 400 without echoing the parse error", async () => {
    const { lines, post, handle } = relay()
    for (const body of ["not json", "[]", JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{}] }] }] })]) {
      const response = await post("/v1/traces", body)
      expect(response.status).toBe(400)
      expect(await response.text()).toBe("")
    }
    const failing = new ReadableStream<Uint8Array>({ pull: (controller) => controller.error(new Error("reset")) })
    const broken = new Request(
      "http://relay.test/v1/metrics",
      { method: "POST", body: failing, duplex: "half" } as RequestInit
    )
    expect((await handle(broken)).status).toBe(400)
    expect(lines).toEqual([])
  })

  it("answers 405 for another method and 404 for another path", async () => {
    const { handle, post } = relay()
    const get = await handle(new Request("http://relay.test/api/telemetry/v1/logs"))
    expect(get.status).toBe(405)
    expect(get.headers.get("allow")).toBe("POST")
    for (const path of ["/v1/profiles", "/v1/logs/extra", "/logs"]) {
      expect((await post(path, "{}")).status).toBe(404)
    }
  })

  it("answers 400 for a body nested deeper than maxNesting, counting only brackets outside strings", async () => {
    const nested = (levels: number, text: string) =>
      JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: "BODY" }] }] }] }).replace(
        "\"BODY\"",
        `${"{\"arrayValue\":{\"values\":[".repeat(levels)}{"stringValue":${JSON.stringify(text)}}${
          "]}}".repeat(levels)
        }`
      )
    const { lines, post } = relay({ maxBodyBytes: 1024 * 1024 })
    // Seven envelope levels, three per array value, and one for the innermost value.
    expect((await post("/v1/logs", nested(18, "[[[[{{{{\"\\"))).status).toBe(200)
    const expected = Array.from({ length: 18 }).reduce<unknown>((inner) => [inner], "[[[[{{{{\"\\")
    expect(lines[0]!.message).toEqual(expected)
    expect((await post("/v1/logs", nested(19, ""))).status).toBe(400)
    expect((await post("/v1/logs", nested(20_000, ""))).status).toBe(400)
  })
})
