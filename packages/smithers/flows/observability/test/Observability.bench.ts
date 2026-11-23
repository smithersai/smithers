import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as HttpEffect from "effect/http/HttpEffect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Metric from "effect/Metric"
import { afterAll, beforeAll, describe, test } from "vitest"
import { Endpoint, LogFailures, Logger as FlowsLogger, OtlpRelay, Resource } from "../src/index.ts"

const sampleResource = {
  serviceName: "smithers-bench",
  serviceVersion: "1.0.0",
  attributes: Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => [`attr.key.${index}`, `value-${index}-payload`])
  )
}

const sampleOtlpLogsBody = JSON.stringify({
  resourceLogs: [{
    resource: {
      attributes: [
        { key: "service.name", value: { stringValue: "browser-bench" } },
        { key: "deployment.environment", value: { stringValue: "prod" } }
      ]
    },
    scopeLogs: [{
      logRecords: Array.from({ length: 50 }, (_, index) => ({
        timeUnixNano: String(1_700_000_000_000_000_000 + index * 1_000_000),
        severityNumber: index % 5 === 0 ? 13 : 9,
        severityText: index % 5 === 0 ? "WARN" : "INFO",
        body: { stringValue: `bench.event.${index % 8}` },
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0123456789abcdef",
        attributes: [
          { key: "run.id", value: { stringValue: `run-${index}` } },
          { key: "password", value: { stringValue: "hunter2" } },
          { key: "note", value: { stringValue: "Bearer abcdefghijklmnopqrstuvwxyz123456" } }
        ]
      }))
    }]
  }]
})

const sinkLogger = Logger.make<unknown, void>(() => undefined)
const relayContext = Context.make(Logger.CurrentLoggers, new Set([sinkLogger])).pipe(
  Context.add(Metric.MetricRegistry, new Map() as Context.Service.Shape<typeof Metric.MetricRegistry>)
)
const relayHandler = HttpEffect.toWebHandler(OtlpRelay.serve())

const logFailureLayer = Layer.mergeAll(
  LogFailures.layer({ keep: 50 }),
  Logger.layer([FlowsLogger.formatStructured.pipe(Logger.map(() => undefined))])
)

let runtime: ManagedRuntime.ManagedRuntime<LogFailures.Recent, never>

beforeAll(() => {
  runtime = ManagedRuntime.make(logFailureLayer)
})

afterAll(async () => {
  await runtime.dispose()
})

describe("observability", () => {
  test("Resource.decodeSync (32 attributes + byte budget)", async ({ bench }) => {
    await bench("Resource.decodeSync", () => {
      Resource.decodeSync(sampleResource)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("Endpoint.decode + signalUrl", async ({ bench }) => {
    await bench("Endpoint.decode", () => {
      const endpoint = Effect.runSync(Endpoint.decode("https://otlp.example.com/v1/", "baseUrl"))
      Endpoint.signalUrl(endpoint, "traces")
    }).run({ time: 120, warmupTime: 30 })
  })

  test("structured log + LogFailures emission inside span", async ({ bench }) => {
    const program = Effect.logWarning("bench.failure.warning").pipe(
      Effect.annotateLogs({
        code: "rate_limited",
        feature: "sync",
        token: "Bearer abcdefghijklmnopqrstuvwxyz123456"
      }),
      Effect.withSpan("bench.span")
    )
    await bench("LogFailures + formatStructured", () => {
      runtime.runSync(program)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("OtlpRelay.serve (50 log records with redaction)", async ({ bench }) => {
    await bench("OtlpRelay.serve 50 logs", async () => {
      const response = await relayHandler(
        new Request("http://relay.test/api/telemetry/v1/logs", {
          method: "POST",
          body: sampleOtlpLogsBody
        }),
        relayContext as Context.Context<never>
      )
      if (!response.ok) throw new Error(`unexpected status ${response.status}`)
    }).run({ time: 150, warmupTime: 30 })
  })
})
