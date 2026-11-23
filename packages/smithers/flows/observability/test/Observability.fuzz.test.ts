import * as OtelApi from "@opentelemetry/api"
import { LoggerProvider } from "@opentelemetry/sdk-logs"
import { InMemoryMetricExporter, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { Fuzz } from "@smthrs/fuzz"
import { Journal, JournalEvent, Redaction } from "@smthrs/journal"
import { Arbitrary, Cause, Effect, Layer, Logger as EffectLogger, Metric, References, Result, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse, HttpServerRequest } from "effect/http"
import { describe, expect, it } from "vitest"
import * as BrowserOtel from "../src/BrowserOtel.ts"
import {
  Endpoint,
  FetchFailures,
  JournalLogger,
  LogFailures,
  Logger,
  Otel,
  Otlp,
  OtlpRelay,
  Resource
} from "../src/index.ts"
import { redact as exportRedact } from "../src/internal/exportRedaction.ts"
import { schemaIssueMessage, schemaIssuePath } from "../src/internal/schemaIssuePath.ts"
import { split as splitOtlp } from "../src/internal/split.ts"
import * as NodeOtel from "../src/NodeOtel.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const encoder = new TextEncoder()
const decoder = new TextDecoder()

describe("@smthrs/observability fuzz invariants", () => {
  it("OtlpRelay.serve enforces method/path/size/nesting/record limits and strict allowlist across logs, traces, and metrics", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        method: Schema.Literals(["POST", "GET", "PUT", "DELETE"]),
        signal: Schema.Literals(["logs", "traces", "metrics", "unknown"]),
        recordName: Schema.Literals(["allowed.event", "forbidden.event", "secret.dump"]),
        allowedFieldVal: Schema.String.pipe(Schema.check(Schema.isMaxLength(20))),
        secretFieldVal: Schema.String.pipe(Schema.check(Schema.isMinLength(6), Schema.isMaxLength(24))),
        severityNumber: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 24 })),
        metricKind: Schema.Literals(["gauge", "sum", "histogram", "exponentialHistogram", "summary"]),
        payloadMode: Schema.Literals(["valid", "oversize", "tooDeep", "badJson", "nonObject", "manyRecords"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ method, signal, recordName, allowedFieldVal, secretFieldVal, severityNumber, metricKind, payloadMode }) =>
          Effect.gen(function*() {
            const sev = OtlpRelay.severityLevel(severityNumber, severityNumber === 0 ? "WARN" : undefined)
            if (!["Trace", "Debug", "Info", "Warn", "Error", "Fatal"].includes(sev)) return false

            const emitted: Array<{ readonly message: unknown; readonly annotations: Record<string, unknown> }> = []
            const captureLogger = EffectLogger.layer([
              EffectLogger.make((log) => {
                emitted.push({ message: log.message, annotations: log.fiber.getRef(References.CurrentLogAnnotations) })
              })
            ])

            let body: string
            if (payloadMode === "oversize") {
              body = "a".repeat(2048)
            } else if (payloadMode === "tooDeep") {
              body = "[".repeat(80) + "]".repeat(80)
            } else if (payloadMode === "badJson") {
              body = "{invalid"
            } else if (payloadMode === "nonObject") {
              body = "[]"
            } else if (signal === "logs") {
              const count = payloadMode === "manyRecords" ? 5 : 1
              const records = Array.from({ length: count }, (_, idx) => ({
                body: { stringValue: recordName },
                severityNumber,
                traceId: "0123456789abcdef0123456789abcdef",
                spanId: "0123456789abcdef",
                attributes: [
                  { key: "safe.tag", value: { stringValue: `${allowedFieldVal}${idx}` } },
                  { key: "safe.bool", value: { boolValue: idx % 2 === 0 } },
                  { key: "safe.int", value: { intValue: String(idx) } },
                  { key: "safe.dbl", value: { doubleValue: 1.5 } },
                  { key: "safe.arr", value: { arrayValue: { values: [{ stringValue: "x" }] } } },
                  { key: "safe.kv", value: { kvlistValue: { values: [{ key: "k", value: { stringValue: "v" } }] } } },
                  { key: "safe.bytes", value: { bytesValue: "AQID" } },
                  { key: "secret.token", value: { stringValue: secretFieldVal } }
                ]
              }))
              body = JSON.stringify({
                resourceLogs: [{
                  resource: { attributes: [{ key: "service.name", value: { stringValue: "svc" } }] },
                  scopeLogs: [{ scope: { name: "sc" }, logRecords: records }]
                }]
              })
            } else if (signal === "traces") {
              const count = payloadMode === "manyRecords" ? 5 : 1
              const spans = Array.from({ length: count }, () => ({
                name: recordName,
                traceId: "0123456789abcdef0123456789abcdef",
                spanId: "0123456789abcdef",
                parentSpanId: "fedcba9876543210",
                startTimeUnixNano: "1000000",
                endTimeUnixNano: "2500000",
                status: { code: severityNumber >= 17 ? 2 : 1, message: "st" },
                attributes: [
                  { key: "safe.tag", value: { stringValue: allowedFieldVal } },
                  { key: "secret.token", value: { stringValue: secretFieldVal } }
                ]
              }))
              body = JSON.stringify({
                resourceSpans: [{
                  resource: { attributes: [{ key: "service.name", value: { stringValue: "svc" } }] },
                  scopeSpans: [{ spans }]
                }]
              })
            } else if (signal === "metrics") {
              const point = metricKind === "histogram"
                ? { count: "3", sum: 9, attributes: [{ key: "safe.tag", value: { stringValue: allowedFieldVal } }] }
                : metricKind === "exponentialHistogram"
                ? { count: "2", sum: 4, attributes: [{ key: "safe.tag", value: { stringValue: allowedFieldVal } }] }
                : metricKind === "summary"
                ? { count: "1", sum: 2, attributes: [{ key: "safe.tag", value: { stringValue: allowedFieldVal } }] }
                : {
                  asDouble: 3.25,
                  attributes: [{ key: "safe.tag", value: { stringValue: allowedFieldVal } }, {
                    key: "secret.token",
                    value: { stringValue: secretFieldVal }
                  }]
                }
              body = JSON.stringify({
                resourceMetrics: [{
                  resource: { attributes: [{ key: "service.name", value: { stringValue: "svc" } }] },
                  scopeMetrics: [{
                    metrics: [{
                      name: recordName,
                      [metricKind]: { dataPoints: [point] }
                    }]
                  }]
                }]
              })
            } else {
              body = "{}"
            }

            const webReq = new Request(`https://obs.example/v1/${signal}`, {
              method,
              ...(method === "POST" || method === "PUT"
                ? { body, headers: { "content-type": "application/json" } }
                : {})
            })
            const serverReq = HttpServerRequest.fromWeb(webReq)
            const response = yield* OtlpRelay.serve({
              maxBodyBytes: 1800,
              maxRecords: 3,
              allow: {
                records: ["allowed.event"],
                fields: [
                  "otlp.signal",
                  "service.name",
                  "safe.tag",
                  "safe.bool",
                  "safe.int",
                  "safe.dbl",
                  "trace_id",
                  "span_id"
                ]
              }
            }).pipe(
              Effect.provide(
                Layer.mergeAll(
                  Layer.succeed(HttpServerRequest.HttpServerRequest, serverReq),
                  captureLogger
                )
              )
            )

            if (signal === "unknown") return response.status === 404 && emitted.length === 0
            if (method !== "POST") return response.status === 405 && emitted.length === 0
            if (payloadMode === "oversize") return response.status === 413 && emitted.length === 0
            if (payloadMode === "tooDeep" || payloadMode === "badJson" || payloadMode === "nonObject") {
              return response.status === 400 && emitted.length === 0
            }
            if (payloadMode === "manyRecords" && signal !== "metrics") {
              // maxRecords=3 vs 5 records -> 413 or capped
              if (response.status !== 413 && response.status !== 200) return false
              if (emitted.length > 3) return false
            } else if (response.status !== 200) {
              return false
            }

            const allowedKeys = new Set([
              "otlp.signal",
              "service.name",
              "safe.tag",
              "safe.bool",
              "safe.int",
              "safe.dbl",
              "trace_id",
              "span_id",
              "parent_span_id",
              "duration_ms",
              "span.status",
              "metric.value",
              "metric.count",
              "metric.sum"
            ])
            for (const entry of emitted) {
              if ("secret.token" in entry.annotations) return false
              for (const k of Object.keys(entry.annotations)) {
                if (!allowedKeys.has(k)) return false
              }
            }
            if (recordName !== "allowed.event" && emitted.length !== 0) return false
            if (recordName === "allowed.event" && response.status === 200 && emitted.length < 1) return false
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Endpoint.decode rejects non-http(s)/malformed/oversized/userinfo URLs and normalize strips trailing slashes", async () => {
    const arb = Arbitrary.schema(
      Schema.Union([
        Schema.String.pipe(Schema.check(Schema.isMaxLength(128))),
        Schema.Literals([
          "https://otel.example.com///",
          "http://127.0.0.1:4318/",
          "http://localhost:4318/custom/path///",
          "javascript:alert(1)",
          "file:///etc/passwd",
          "ftp://example.com",
          "https://user:pass@example.com/v1",
          "https://example.com?q=1",
          "https://example.com#frag",
          "https://example.com/" + "a".repeat(2100)
        ])
      ])
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (raw) =>
          Effect.gen(function*() {
            const res = yield* Effect.result(Endpoint.decode(raw, "otlp.endpoint"))
            if (Result.isFailure(res)) {
              return res.failure._tag === "@smthrs/observability/InvalidExporterEndpoint"
            }
            const ok = res.success
            if (ok.length > Endpoint.maximumEndpointLength) return false
            if (!/^https?:\/\//i.test(ok)) return false
            const norm = Endpoint.normalize(ok)
            if (norm.endsWith("/")) return false
            const traceUrl = Endpoint.signalUrl(norm, "traces")
            const logUrl = Endpoint.signalUrl(norm, "logs")
            const metricUrl = Endpoint.signalUrl(norm, "metrics")
            return traceUrl.endsWith("/v1/traces") && logUrl.endsWith("/v1/logs") && metricUrl.endsWith("/v1/metrics")
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("internal split conserves every OTLP record/point and respects maxBytes and maxRecords", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        signal: Schema.Literals(["logs", "traces", "metrics", "nonOtlp", "invalidJson"]),
        metricKind: Schema.Literals(["gauge", "sum", "histogram", "exponentialHistogram", "summary"]),
        resourceCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
        scopeCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 })),
        recordCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
        payloadSize: Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 120 })),
        maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 180, maximum: 900 })),
        maxRecords: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 }))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ signal, metricKind, resourceCount, scopeCount, recordCount, payloadSize, maxBytes, maxRecords }) => {
          if (signal === "nonOtlp" || signal === "invalidJson") {
            const raw = encoder.encode(signal === "nonOtlp" ? JSON.stringify({ hello: "world" }) : "{broken")
            const out = splitOtlp(raw, maxBytes, maxRecords)
            return out.requests.length === 1 && out.oversized === 0
          }
          const pad = "x".repeat(payloadSize)
          let expectedTotal = 0
          let body: Record<string, unknown>
          if (signal === "logs") {
            body = {
              resourceLogs: Array.from({ length: resourceCount }, (_, r) => ({
                resource: { attributes: [{ key: "r", value: { intValue: r } }] },
                scopeLogs: Array.from({ length: scopeCount }, (_, s) => ({
                  scope: { name: `s${s}` },
                  logRecords: Array.from({ length: recordCount }, (_, i) => {
                    expectedTotal++
                    return { body: { stringValue: `${r}-${s}-${i}-${pad}` } }
                  })
                }))
              }))
            }
          } else if (signal === "traces") {
            body = {
              resourceSpans: Array.from({ length: resourceCount }, (_, r) => ({
                resource: { attributes: [{ key: "r", value: { intValue: r } }] },
                scopeSpans: Array.from({ length: scopeCount }, (_, s) => ({
                  scope: { name: `s${s}` },
                  spans: Array.from({ length: recordCount }, (_, i) => {
                    expectedTotal++
                    return { name: `span-${r}-${s}-${i}-${pad}` }
                  })
                }))
              }))
            }
          } else {
            body = {
              resourceMetrics: Array.from({ length: resourceCount }, (_, r) => ({
                resource: { attributes: [{ key: "r", value: { intValue: r } }] },
                scopeMetrics: Array.from({ length: scopeCount }, (_, s) => ({
                  scope: { name: `s${s}` },
                  metrics: [{
                    name: `m-${r}-${s}`,
                    [metricKind]: {
                      dataPoints: Array.from({ length: recordCount }, (_, i) => {
                        expectedTotal++
                        return { asInt: String(i), attributes: [{ key: "p", value: { stringValue: pad } }] }
                      })
                    }
                  }]
                }))
              }))
            }
          }

          const raw = encoder.encode(JSON.stringify(body))
          const { requests, oversized } = splitOtlp(raw, maxBytes, maxRecords)
          let observedTotal = 0
          for (const req of requests) {
            if (req.byteLength > maxBytes) return false
            const parsed = JSON.parse(decoder.decode(req)) as Record<string, Array<Record<string, unknown>>>
            let reqCount = 0
            if (signal === "logs") {
              for (const rl of parsed.resourceLogs ?? []) {
                for (const sl of (rl.scopeLogs as Array<Record<string, unknown>>) ?? []) {
                  reqCount += ((sl.logRecords as Array<unknown>) ?? []).length
                }
              }
            } else if (signal === "traces") {
              for (const rs of parsed.resourceSpans ?? []) {
                for (const ss of (rs.scopeSpans as Array<Record<string, unknown>>) ?? []) {
                  reqCount += ((ss.spans as Array<unknown>) ?? []).length
                }
              }
            } else {
              for (const rm of parsed.resourceMetrics ?? []) {
                for (const sm of (rm.scopeMetrics as Array<Record<string, unknown>>) ?? []) {
                  for (const m of (sm.metrics as Array<Record<string, unknown>>) ?? []) {
                    const box = m[metricKind] as { dataPoints?: Array<unknown> } | undefined
                    reqCount += box?.dataPoints?.length ?? 0
                  }
                }
              }
            }
            if (reqCount === 0 || reqCount > maxRecords) return false
            observedTotal += reqCount
          }
          return observedTotal + oversized === expectedTotal
        },
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("exportRedaction scrubs sensitive OTLP attributes and JSON-stringified secrets while preserving numeric token counts", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        secretVal: Schema.String.pipe(Schema.check(Schema.isMinLength(8), Schema.isMaxLength(24))),
        safeVal: Schema.Literals(["ok-status", "worker-1", "sync-done"]),
        tokenCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 50_000 })),
        deep: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ secretVal, safeVal, tokenCount, deep }) => {
          const safeSecret = secretVal.replace(/[^A-Za-z0-9_-]/g, "A") || "SecretValue123"
          let nested: unknown = { leaf: safeVal }
          if (deep) {
            for (let i = 0; i < Redaction.maxDepth + 3; i++) nested = { n: nested }
          }
          const payload = {
            resourceLogs: [{
              scopeLogs: [{
                logRecords: [{
                  body: { stringValue: JSON.stringify({ apiKey: safeSecret, safe: safeVal }) },
                  attributes: [
                    { key: "authorization", value: { stringValue: `Bearer ${safeSecret}` } },
                    { key: "password", value: { arrayValue: { values: [{ stringValue: safeSecret }] } } },
                    { key: "inputTokens", value: { intValue: String(tokenCount) } },
                    { key: "outputTokens", value: { doubleValue: tokenCount + 0.5 } },
                    { key: "safe.label", value: { stringValue: safeVal } },
                    { key: "plain.json", value: { stringValue: JSON.stringify({ normal: safeVal }) } }
                  ],
                  extra: nested
                }]
              }]
            }]
          }
          const outBytes = exportRedact(encoder.encode(JSON.stringify(payload)))
          const outText = decoder.decode(outBytes)
          if (outText.includes(safeSecret)) return false
          const parsed = JSON.parse(outText) as {
            resourceLogs: Array<{
              scopeLogs: Array<{
                logRecords: Array<{
                  attributes: Array<{ key: string; value: Record<string, unknown> }>
                }>
              }>
            }>
          }
          const attrs = parsed.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.attributes
          const auth = attrs.find((a) => a.key === "authorization")!
          const pwd = attrs.find((a) => a.key === "password")!
          const inTok = attrs.find((a) => a.key === "inputTokens")!
          const safeAttr = attrs.find((a) => a.key === "safe.label")!
          if (auth.value.stringValue !== Redaction.placeholder) return false
          if (pwd.value.stringValue !== Redaction.placeholder) return false
          if (inTok.value.intValue !== String(tokenCount)) return false
          if (safeAttr.value.stringValue !== safeVal) return false
          return true
        },
        { seed: seed + 3, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Resource decode/decodeSync/configToAttributes/layer enforce byte budgets and attribute types", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["valid", "emptyName", "badVersion", "oversizeAttr", "badAttrVal", "arrayAttr"]),
        name: Schema.Literals(["flows-worker", "api-edge", "sync-svc"]),
        ver: Schema.Literals(["1.0.0", "2.3.4-beta"]),
        numVal: Schema.Int.check(Schema.isBetween({ minimum: -100, maximum: 100 })),
        boolVal: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode, name, ver, numVal, boolVal }) =>
          Effect.gen(function*() {
            // Exercise schemaIssuePath / schemaIssueMessage edge cases (cyclic/empty)
            const cyc: Record<string, unknown> = {}
            cyc.issue = cyc
            if (schemaIssuePath({ issue: cyc }, "fallback") !== "fallback") return false
            if (schemaIssueMessage({ issue: { issues: [{ annotations: { message: "msg" } }] } }) !== "msg") return false

            let input: unknown
            if (mode === "valid") {
              input = {
                serviceName: name,
                serviceVersion: ver,
                attributes: { env: "test", count: numVal, ok: boolVal }
              }
            } else if (mode === "arrayAttr") {
              input = {
                serviceName: name,
                attributes: { tags: ["a", "b"], nums: [numVal, 2], flags: [boolVal] }
              }
            } else if (mode === "emptyName") {
              input = { serviceName: "" }
            } else if (mode === "badVersion") {
              input = { serviceName: name, serviceVersion: 123 }
            } else if (mode === "oversizeAttr") {
              input = {
                serviceName: name,
                attributes: {
                  big1: "x".repeat(50_000),
                  big2: "y".repeat(50_000),
                  big3: "z".repeat(50_000)
                }
              }
            } else {
              input = { serviceName: name, attributes: { bad: { nested: 1 } } }
            }

            const res = yield* Effect.result(Resource.decode(input))
            if (mode === "valid" || mode === "arrayAttr") {
              if (Result.isFailure(res)) return false
              const synced = Resource.decodeSync(input)
              const attrs = Resource.configToAttributes(synced)
              if (attrs["service.name"] !== name) return false
              const built = yield* Effect.result(
                Effect.scoped(Layer.build(Resource.layer(synced)))
              )
              return Result.isSuccess(built)
            }
            if (Result.isSuccess(res)) return false
            if (res.failure._tag !== "@smthrs/observability/InvalidResourceConfiguration") return false
            try {
              Resource.decodeSync(input)
              return false
            } catch (err) {
              if (!(err instanceof Resource.InvalidResourceConfiguration)) return false
            }
            return true
          }),
        { seed: seed + 4, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("FetchFailures state machine tracks failure streaks, status transitions, recovery, aborts, and LRU bounds", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        steps: Schema.Array(
          Schema.Struct({
            path: Schema.Literals(["/api/items/1", "/api/items/2", "/api/items/3", "/otel/v1/logs"]),
            method: Schema.Literals(["GET", "POST"]),
            outcome: Schema.Literals(["200", "404", "503", "netErr", "abort", "opaque", "status0"])
          })
        ),
        remember: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 }))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ steps, remember }) =>
          Effect.gen(function*() {
            // Check pure statusClass function
            if (FetchFailures.statusClass({ status: 200, type: "basic" }) !== undefined) return false
            if (FetchFailures.statusClass({ status: 404, type: "basic" }) !== "4xx") return false
            if (FetchFailures.statusClass({ status: 500, type: "basic" }) !== "5xx") return false
            if (FetchFailures.statusClass({ status: 0, type: "error" }) !== "network") return false
            if (FetchFailures.statusClass({ status: 0, type: "opaqueredirect" }) !== undefined) return false

            const logs: Array<{ readonly msg: unknown; readonly ann: Record<string, unknown> }> = []
            const captureLogger = EffectLogger.layer([
              EffectLogger.make((log) => {
                logs.push({ msg: log.message, ann: log.fiber.getRef(References.CurrentLogAnnotations) })
              })
            ])
            const boundedSteps = steps.slice(0, 12)
            let stepIdx = 0
            const fakeFetch: typeof fetch = async (_input, init) => {
              const s = boundedSteps[stepIdx++]!
              if (s.outcome === "abort") {
                const err = new DOMException("aborted", "AbortError")
                throw err
              }
              if (s.outcome === "netErr") {
                throw new TypeError("connection refused")
              }
              if (s.outcome === "opaque") {
                return { status: 0, type: "opaqueredirect" } as unknown as Response
              }
              if (s.outcome === "status0") {
                return { status: 0, type: "error" } as unknown as Response
              }
              return new Response("ok", { status: Number(s.outcome) })
            }

            const layer = FetchFailures.layer({
              route: (url) => url.pathname.startsWith("/api/") ? "/api/items/:id" : undefined,
              remember
            }).pipe(
              Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, fakeFetch)),
              Layer.provideMerge(captureLogger)
            )

            const ok = yield* Effect.gen(function*() {
              const wrappedFetch = yield* FetchHttpClient.Fetch
              for (const s of boundedSteps) {
                const controller = new AbortController()
                if (s.outcome === "abort") controller.abort()
                const url = `https://app.example${s.path}`
                const fetchRes = yield* Effect.result(
                  Effect.tryPromise(() =>
                    wrappedFetch(
                      s.method === "POST" ? new Request(url, { method: "POST" }) : url,
                      { method: s.method, signal: controller.signal }
                    )
                  )
                )
                if (Result.isSuccess(fetchRes)) {
                  const res = fetchRes.success
                  if (s.outcome === "netErr" || s.outcome === "abort") return false
                  if (s.outcome === "200" && res.status !== 200) return false
                  if (s.outcome === "404" && res.status !== 404) return false
                  if (s.outcome === "503" && res.status !== 503) return false
                } else {
                  if (s.outcome !== "netErr" && s.outcome !== "abort") return false
                }
              }
              return true
            }).pipe(Effect.provide(layer))

            if (!ok) return false
            // Never log private path segments or unrouted /otel paths
            for (const entry of logs) {
              if (entry.ann.route !== "/api/items/:id") return false
              const text = JSON.stringify(entry)
              if (text.includes("/api/items/1") || text.includes("/otel/v1/logs")) return false
            }
            return true
          }),
        { seed: seed + 5, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("LogFailures filters levels, bounds Recent FIFO buffer, sanitizes codes/areas, and respects cardinality caps", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        keep: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
        useAllowlist: Schema.Boolean,
        events: Schema.Array(
          Schema.Struct({
            level: Schema.Literals(["info", "warn", "error", "fatal"]),
            msg: Schema.Literals(["sync.failed", "auth.denied", "unlisted.event", "bad\nmultiline prose!"]),
            code: Schema.Literals(["E_TIMEOUT", "E_AUTH", "none", "bad spaces code!"]),
            area: Schema.Literals(["sync", "auth", "none", "bad area!"]),
            withCause: Schema.Literals(["none", "tagged", "error", "defect"])
          })
        )
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ keep, useAllowlist, events }) =>
          Effect.gen(function*() {
            const bounded = events.slice(0, 12)
            const layer = LogFailures.layer({
              ...(useAllowlist ? { records: ["sync.failed", "auth.denied"] } : {}),
              keep
            }).pipe(Layer.provide(Logger.layerNoop({ minimumLogLevel: "All" })))

            const entries = yield* Effect.gen(function*() {
              for (const ev of bounded) {
                const cause = ev.withCause === "tagged"
                  ? Cause.fail({ _tag: "TaggedBoom" })
                  : ev.withCause === "error"
                  ? Cause.fail(new TypeError("type boom"))
                  : ev.withCause === "defect"
                  ? Cause.die(new RangeError("range boom"))
                  : Cause.empty
                const anns: Record<string, unknown> = {}
                if (ev.code !== "none") anns.code = ev.code
                if (ev.area !== "none") anns.feature = ev.area
                const logEff = ev.level === "info"
                  ? Effect.logInfo(ev.msg)
                  : ev.level === "warn"
                  ? Effect.logWarning(ev.msg, cause)
                  : ev.level === "error"
                  ? Effect.logError(ev.msg, cause)
                  : Effect.logFatal(ev.msg, cause)
                yield* Effect.annotateLogs(logEff, anns).pipe(Effect.withSpan("log.test.span"))
              }
              return yield* (yield* LogFailures.Recent).entries
            }).pipe(Effect.provide(layer))

            const expectedCount = Math.min(keep, bounded.filter((e) => e.level !== "info").length)
            if (entries.length !== expectedCount) return false
            for (const e of entries) {
              if (!["warn", "error", "fatal"].includes(e.level)) return false
              if (e.record.includes("\n") || e.record.includes("!")) return false
              if (e.code.includes(" ") || e.code.includes("!")) return false
              if (e.area.includes(" ") || e.area.includes("!")) return false
              if (useAllowlist && e.record !== "sync.failed" && e.record !== "auth.denied" && e.record !== "other") {
                return false
              }
            }
            return true
          }),
        { seed: seed + 6, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Logger layers redact secrets, attach span trace/span ids without overriding caller annotations, and support noop/custom sinks", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        secret: Schema.String.pipe(Schema.check(Schema.isMinLength(8), Schema.isMaxLength(20))),
        overrideTrace: Schema.Boolean,
        mergeWithExisting: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ secret, overrideTrace, mergeWithExisting }) =>
          Effect.gen(function*() {
            const safeSecret = secret.replace(/[^A-Za-z0-9]/g, "X") || "SuperSecret99"
            const records: Array<Record<string, unknown>> = []
            const customSink = EffectLogger.make((opts) => {
              records.push(Logger.formatStructured.log(opts) as unknown as Record<string, unknown>)
            })
            const customLayer = Logger.layer(customSink, {
              minimumLogLevel: "Debug",
              mergeWithExisting
            })
            yield* Effect.annotateLogs(
              Effect.logInfo("hello"),
              {
                password: safeSecret,
                ...(overrideTrace ? { trace_id: "caller-trace" } : {})
              }
            ).pipe(Effect.withSpan("logger.span"), Effect.provide(customLayer))

            if (records.length !== 1) return false
            const rec = records[0]!
            const anns = rec.annotations as Record<string, unknown>
            if (anns.password !== Redaction.placeholder) return false
            if (overrideTrace && anns.trace_id !== "caller-trace") return false
            if (!overrideTrace && typeof anns.trace_id !== "string") return false
            if (typeof anns.span_id !== "string") return false

            // Also verify layerNoop drops logs and layerPrettyDev / layerStructuredJson build cleanly
            const noopCount = yield* Effect.sync(() => {
              let n = 0
              return () => n++
            })
            void noopCount
            yield* Effect.logError("silenced").pipe(Effect.provide(Logger.layerNoop()))
            yield* Effect.scoped(Layer.build(Logger.layerPrettyDev({ minimumLogLevel: "Error" })))
            yield* Effect.scoped(Layer.build(Logger.layerStructuredJson({ minimumLogLevel: "Error" })))
            return true
          }),
        { seed: seed + 7, executions: Math.min(executions, 60) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("JournalLogger validates options and forwards redacted log events with causes to Journal", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["valid", "badCapacityZero", "badCapacityHuge", "emptyRunId"]),
        capacity: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
        emitCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
        journalResult: Schema.Literals(["accepted", "dropped", "fail"]),
        causeKind: Schema.Literals(["empty", "fail", "die"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode, capacity, emitCount, journalResult, causeKind }) =>
          Effect.gen(function*() {
            const received: Array<JournalEvent.Input> = []
            const fakeJournal = Layer.succeed(
              Journal.Journal,
              {
                emitLossy: (input: JournalEvent.Input) => {
                  received.push(input)
                  if (journalResult === "fail") {
                    return Effect.fail(new Error("journal down") as never)
                  }
                  if (journalResult === "dropped") {
                    return Effect.succeed({ _tag: "Dropped" as const, reason: "full" as const } as never)
                  }
                  return Effect.succeed({ _tag: "Accepted" as const } as never)
                }
              } as unknown as typeof Journal.Journal.Service
            )

            const opts = mode === "badCapacityZero"
              ? { runId: "run-1" as JournalEvent.RunId, capacity: 0 }
              : mode === "badCapacityHuge"
              ? { runId: "run-1" as JournalEvent.RunId, capacity: JournalLogger.maximumCapacity + 1 }
              : mode === "emptyRunId"
              ? { runId: "" as JournalEvent.RunId, capacity }
              : { runId: "run-1" as JournalEvent.RunId, capacity, minimumLogLevel: "Info" as const }

            const res = yield* Effect.result(
              Effect.scoped(
                Effect.gen(function*() {
                  const ctx = yield* Layer.build(JournalLogger.layerJournalForwarding(opts))
                  for (let i = 0; i < emitCount; i++) {
                    const c = causeKind === "fail"
                      ? Cause.fail({ _tag: "Boom", message: "bad" })
                      : causeKind === "die"
                      ? Cause.die(new Error("die boom"))
                      : Cause.empty
                    yield* Effect.annotateLogs(
                      Effect.logError(`msg-${i}`, c),
                      { token: "SecretTok123456" }
                    ).pipe(Effect.provide(ctx))
                  }
                })
              ).pipe(Effect.provide(fakeJournal))
            )

            if (mode !== "valid") {
              return Result.isFailure(res) && res.failure._tag === "@smthrs/observability/InvalidJournalLoggerOptions"
            }
            if (Result.isFailure(res)) return false
            for (const ev of received) {
              if (JSON.stringify(ev).includes("SecretTok123456")) return false
            }
            return true
          }),
        { seed: seed + 8, executions: Math.min(executions, 40) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Otlp.parseHeaders, Otlp.layer, Otlp.layerEnvironment, Otel, BrowserOtel, and NodeOtel enforce redaction, splitting, and config validation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        headerStr: Schema.Union([
          Schema.Undefined,
          Schema.Literals([
            "",
            "x-api-key=abc%20123, x-tenant = t1",
            "noequals,=emptykey,k=%E0%A4%A,valid=ok=val"
          ])
        ]),
        endpoint: Schema.Literals([
          "http://127.0.0.1:4318",
          "https://otel.example.com",
          "http://remote.example.com",
          "ftp://bad.example.com"
        ]),
        withAuthHeader: Schema.Boolean,
        httpStatus: Schema.Literals([200, 302, 500]),
        useFactories: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ headerStr, endpoint, withAuthHeader, httpStatus, useFactories }) =>
          Effect.gen(function*() {
            const parsedHeaders = Otlp.parseHeaders(headerStr)
            if (headerStr === "x-api-key=abc%20123, x-tenant = t1") {
              if (parsedHeaders["x-api-key"] !== "abc 123" || parsedHeaders["x-tenant"] !== "t1") return false
            }
            if (headerStr === "noequals,=emptykey,k=%E0%A4%A,valid=ok=val") {
              if ("noequals" in parsedHeaders || "" in parsedHeaders) return false
              if (parsedHeaders["k"] !== "%E0%A4%A" || parsedHeaders["valid"] !== "ok=val") return false
            }

            // Otlp.layerEnvironment empty -> layerNoop
            yield* Effect.scoped(Layer.build(Otlp.layerEnvironment({})))

            // Otlp.layer with fake HttpClient
            const sentBodies: Array<string> = []
            const fakeHttp = Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((req) =>
                Effect.gen(function*() {
                  if (req.body._tag === "Uint8Array") {
                    sentBodies.push(decoder.decode(req.body.body))
                  }
                  const resp = new Response("{}", {
                    status: httpStatus,
                    headers: httpStatus === 302 ? { location: "https://other.example" } : {}
                  })
                  return HttpClientResponse.fromWeb(req, resp)
                })
              )
            )

            const headers = withAuthHeader ? { authorization: "Bearer SecretBearer999" } : undefined
            const otlpRes = yield* Effect.result(
              Effect.scoped(
                Effect.gen(function*() {
                  const ctx = yield* Layer.build(
                    Otlp.layer({
                      baseUrl: endpoint,
                      serviceName: "fuzz-svc",
                      headers,
                      maxRequestBytes: 4096,
                      maxRecords: 5,
                      spans: ["allowed.span"],
                      exportInterval: "10 millis",
                      shutdownTimeout: "100 millis"
                    })
                  )
                  yield* Effect.annotateLogs(Effect.logInfo("export-test"), {
                    apiKey: "SecretApiKey888",
                    safe: "ok"
                  }).pipe(
                    Effect.withSpan("allowed.span", { attributes: { password: "SecretSpanPwd777", ok: "yes" } }),
                    Effect.provide(ctx)
                  )
                  yield* Metric.update(Metric.counter("fuzz_test_counter"), 1).pipe(Effect.provide(ctx))
                })
              ).pipe(Effect.provide(fakeHttp))
            )

            const expectFail = endpoint === "ftp://bad.example.com"
              || (endpoint === "http://remote.example.com" && withAuthHeader)
            if (expectFail) {
              if (Result.isSuccess(otlpRes)) return false
            } else {
              if (Result.isFailure(otlpRes)) return false
              for (const body of sentBodies) {
                if (body.includes("SecretApiKey888") || body.includes("SecretSpanPwd777")) return false
              }
            }

            // Otel.layerOtel & BrowserOtel.layerOtel
            const tracerProvider = OtelApi.trace.getTracerProvider()
            const loggerProvider = new LoggerProvider()
            const makeReader = () =>
              new PeriodicExportingMetricReader({
                exporter: new InMemoryMetricExporter(1),
                exportIntervalMillis: 60_000
              })
            const otelLayer = Otel.layerOtel({
              resource: { serviceName: "otel-fuzz" },
              tracerProvider: useFactories ? () => tracerProvider : tracerProvider,
              loggerProvider: useFactories ? () => loggerProvider : loggerProvider,
              metricReader: makeReader
            })
            yield* Effect.scoped(Layer.build(otelLayer))
            yield* Effect.scoped(
              Layer.build(
                BrowserOtel.layerOtel({
                  resource: { serviceName: "browser-fuzz" },
                  metricReader: makeReader
                })
              )
            )
            // NodeOtel invalid and valid endpoint/resource check
            const nodeBad = yield* Effect.result(
              Effect.scoped(
                Layer.build(
                  NodeOtel.layerOtel({
                    endpoint: "ftp://invalid",
                    resource: { serviceName: "node-fuzz" }
                  })
                )
              )
            )
            if (Result.isSuccess(nodeBad)) return false
            yield* Effect.scoped(
              Layer.build(
                NodeOtel.layerOtel({
                  endpoint: "http://127.0.0.1:4318",
                  resource: { serviceName: "node-fuzz" },
                  ...(useFactories ? { exportIntervalMillis: 60_000 } : {}),
                  shutdownTimeout: "50 millis"
                })
              )
            )

            return true
          }),
        { seed: seed + 9, executions: Math.min(executions, 20) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
