import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { InMemoryMetricExporter, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { Effect, Logger, Metric, Option } from "effect"
import { createServer, type Server } from "node:http"
import { describe, expect, it, vi } from "vitest"
import * as BrowserOtel from "../src/BrowserOtel.ts"
import * as NodeOtel from "../src/NodeOtel.ts"
import * as Resource from "../src/Resource.ts"

/** Host SDK layers exercised through their emitted signals and scoped resources. */
describe("NodeOtel.layerOtel", () => {
  /**
   * The one piece of logic this module owns is which signal goes to which
   * OTLP path, and asserting `Endpoint.signalUrl` alone leaves the wiring
   * unverified: permuting the `"traces"`, `"metrics"`, and `"logs"` literals
   * sends every record to a collector path that rejects it while the layer
   * still builds, releases, and reports success. So this drives a real
   * collector and reads back which payload arrived where. The OTLP/HTTP JSON
   * body names its own signal (`resourceSpans`, `resourceMetrics`,
   * `resourceLogs`), which is what makes a swap visible rather than just the
   * set of paths, which a swap preserves.
   */
  it.each([{ basePath: "", exportIntervalMillis: undefined }, {
    basePath: "/tenant/9//",
    exportIntervalMillis: 60_000
  }])(
    "posts each signal below base path '$basePath' on a real collector",
    async ({ basePath, exportIntervalMillis }) => {
      const received: Array<{ readonly path: string; readonly keys: ReadonlyArray<string> }> = []
      const server: Server = createServer((request, response) => {
        const chunks: Array<Buffer> = []
        request.on("data", (chunk: Buffer) => chunks.push(chunk))
        request.on("end", () => {
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
          received.push({
            path: request.url ?? "",
            keys: Object.keys(body as Record<string, unknown>)
          })
          response.writeHead(200, { "content-type": "application/json" })
          response.end("{}")
        })
      })

      try {
        const port = await new Promise<number>((resolve, reject) => {
          server.once("error", reject)
          server.listen(0, "127.0.0.1", () => {
            const address = server.address()
            if (address === null || typeof address === "string") reject(new Error("no ephemeral port"))
            else resolve(address.port)
          })
        })

        const counter = Metric.counter("flows-test/host-otel/records")
        await Effect.runPromise(
          Effect.gen(function*() {
            yield* Effect.void.pipe(Effect.withSpan("host-otel-span"))
            yield* Effect.logInfo("host otel record")
            yield* Metric.update(counter, 1)
          }).pipe(
            Effect.provide(NodeOtel.layerOtel({
              endpoint: `http://127.0.0.1:${port}${basePath}`,
              resource: { serviceName: "flows-test", serviceVersion: "1" },
              // Release, not the interval, is the deterministic flush: closing
              // the scope force-flushes both batch processors and collects the
              // metric reader once.
              exportIntervalMillis,
              shutdownTimeout: "10 seconds"
            })),
            Effect.scoped
          )
        )

        for (let attempt = 0; attempt < 200 && received.length < 3; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }

        const bySignal = new Map(received.map((request) => [request.keys.join(","), request.path]))
        expect(Object.fromEntries(bySignal)).toEqual({
          resourceSpans: `${basePath.replace(/\/+$/, "")}/v1/traces`,
          resourceMetrics: `${basePath.replace(/\/+$/, "")}/v1/metrics`,
          resourceLogs: `${basePath.replace(/\/+$/, "")}/v1/logs`
        })
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }
  )
})

/**
 * The browser layer forwards caller-built processors and readers into the web
 * SDK, which owns them: it shuts each one down when the scope closes. The
 * in-memory exporters clear themselves on that shutdown, so every signal is
 * read inside the scope and asserted after it.
 */
const emitAndRead = <A>(
  options: BrowserOtel.Options,
  metricReaders: ReadonlyArray<PeriodicExportingMetricReader>,
  read: () => A
) =>
  Effect.runPromise(
    Effect.gen(function*() {
      yield* Effect.void.pipe(Effect.withSpan("browser-span"))
      yield* Effect.logInfo("browser record")
      yield* Metric.update(Metric.counter("browser.records"), 2)
      for (const reader of metricReaders) yield* Effect.promise(() => reader.forceFlush())
      return read()
    }).pipe(
      Effect.provide(BrowserOtel.layerOtel(options)),
      Effect.provideService(Metric.MetricRegistry, new Map()),
      Effect.scoped
    )
  )

const spanNames = (exporter: InMemorySpanExporter) => exporter.getFinishedSpans().map((span) => span.name)
const logBodies = (exporter: InMemoryLogRecordExporter) => exporter.getFinishedLogRecords().map((record) => record.body)
const counters = (exporter: InMemoryMetricExporter) =>
  exporter.getMetrics().flatMap((metrics) =>
    metrics.scopeMetrics.flatMap((scope) =>
      scope.metrics.map((metric) => [metric.descriptor.name, metric.dataPoints.map((point) => point.value)] as const)
    )
  )

describe("BrowserOtel.layerOtel", () => {
  it("builds and releases a layer with no caller-supplied processors", async () => {
    const resource = await Effect.runPromise(
      Effect.serviceOption(Resource.Resource).pipe(
        Effect.map(Option.getOrThrow),
        Effect.provide(BrowserOtel.layerOtel({
          resource: { serviceName: "flows-test", serviceVersion: "1" }
        })),
        Effect.scoped
      )
    )
    expect(resource.attributes).toMatchObject({ "service.name": "flows-test", "service.version": "1" })
  })

  it("forwards each signal to a single injected processor and shuts it down on release", async () => {
    const traceExporter = new InMemorySpanExporter()
    const logExporter = new InMemoryLogRecordExporter()
    const metricExporter = new InMemoryMetricExporter(0)
    const spanProcessor = new SimpleSpanProcessor(traceExporter)
    const logRecordProcessor = new SimpleLogRecordProcessor({ exporter: logExporter })
    const metricReader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 60_000
    })
    const spanShutdown = vi.spyOn(spanProcessor, "shutdown")
    const logShutdown = vi.spyOn(logRecordProcessor, "shutdown")
    const readerShutdown = vi.spyOn(metricReader, "shutdown")

    const received = await emitAndRead(
      {
        resource: { serviceName: "flows-test", serviceVersion: "1" },
        spanProcessor: () => spanProcessor,
        logRecordProcessor: () => logRecordProcessor,
        metricReader: () => metricReader,
        loggerMergeWithExisting: false
      },
      [metricReader],
      () => ({
        spans: spanNames(traceExporter),
        logs: logBodies(logExporter),
        metrics: counters(metricExporter)
      })
    )

    expect(received.spans).toEqual(["browser-span"])
    expect(received.logs).toEqual(["browser record"])
    expect(received.metrics).toEqual([["browser.records", [2]]])
    expect(spanShutdown).toHaveBeenCalledTimes(1)
    expect(logShutdown).toHaveBeenCalledTimes(1)
    expect(readerShutdown).toHaveBeenCalledTimes(1)
  })

  it("installs every processor and reader an array holds", async () => {
    const traceExporters = [new InMemorySpanExporter(), new InMemorySpanExporter()]
    const logExporters = [new InMemoryLogRecordExporter(), new InMemoryLogRecordExporter()]
    const metricExporters = [new InMemoryMetricExporter(0), new InMemoryMetricExporter(0)]
    const metricReaders = metricExporters.map((exporter) =>
      new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })
    )
    const received = await emitAndRead(
      {
        resource: { serviceName: "flows-test", serviceVersion: "1" },
        spanProcessor: () => traceExporters.map((exporter) => new SimpleSpanProcessor(exporter)),
        logRecordProcessor: () => logExporters.map((exporter) => new SimpleLogRecordProcessor({ exporter })),
        metricReader: () => metricReaders,
        loggerMergeWithExisting: false
      },
      metricReaders,
      () => ({
        spans: traceExporters.map(spanNames),
        logs: logExporters.map(logBodies),
        metrics: metricExporters.map(counters)
      })
    )

    expect(received.spans).toEqual([["browser-span"], ["browser-span"]])
    expect(received.logs).toEqual([["browser record"], ["browser record"]])
    expect(received.metrics).toEqual([[["browser.records", [2]]], [["browser.records", [2]]]])
  })

  it.each([
    [true, ["browser record"]],
    [false, []]
  ])("keeps the ambient loggers when loggerMergeWithExisting is %s", async (merge, ambient) => {
    const logExporter = new InMemoryLogRecordExporter()
    const ambientMessages: Array<unknown> = []
    const ambientLogger = Logger.make<unknown, void>((options) => {
      ambientMessages.push(options.message)
    })
    let exported: ReadonlyArray<unknown> = []
    await Effect.runPromise(
      Effect.gen(function*() {
        yield* Effect.logInfo("browser record")
        exported = logBodies(logExporter)
      }).pipe(
        Effect.provide(BrowserOtel.layerOtel({
          resource: { serviceName: "flows-test" },
          logRecordProcessor: () => new SimpleLogRecordProcessor({ exporter: logExporter }),
          loggerMergeWithExisting: merge
        })),
        Effect.provide(Logger.layer([ambientLogger])),
        Effect.scoped
      )
    )

    expect(exported).toEqual(["browser record"])
    expect(ambientMessages.flat()).toEqual(ambient)
  })
})
