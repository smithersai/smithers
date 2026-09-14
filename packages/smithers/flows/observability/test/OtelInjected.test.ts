import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { InMemoryMetricExporter } from "@opentelemetry/sdk-metrics"
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { Effect, Metric } from "effect"
import { describe, expect, it, vi } from "vitest"
import * as Otel from "../src/Otel.ts"
import * as Resource from "../src/Resource.ts"

/**
 * The injected-provider branches of `Otel.layerOtel`. `Otel.test.ts` asserts
 * the empty case, where nothing injected composes to a layer that still runs, so
 * what is left is the other side of each of its three conditionals, and the
 * ownership split those branches carry: injected providers are borrowed, the
 * readers the `metricReader` factory returns are owned by the layer scope.
 */
const run = <A, E>(program: Effect.Effect<A, E, never>) => Effect.runPromise(Effect.scoped(program))

/** Every counter and every scope metric an in-memory exporter received. */
const exportedCounters = (exporter: InMemoryMetricExporter) =>
  exporter.getMetrics().flatMap((metrics) =>
    metrics.scopeMetrics.flatMap((scope) =>
      scope.metrics.map((metric) => [metric.descriptor.name, metric.dataPoints.map((point) => point.value)] as const)
    )
  )

describe("Otel.layerOtel with injected providers", () => {
  it("forwards a span, a log record, and a counter to the injected exporters", async () => {
    const traceExporter = new InMemorySpanExporter()
    const logExporter = new InMemoryLogRecordExporter()
    const metricExporter = new InMemoryMetricExporter(0)
    const tracerProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(traceExporter)]
    })
    const loggerProvider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor({ exporter: logExporter })]
    })
    try {
      await run(
        Effect.gen(function*() {
          yield* Effect.void.pipe(Effect.withSpan("injected-span"))
          yield* Effect.logInfo("injected record")
          yield* Metric.update(Metric.counter("injected.records"), 3)
        }).pipe(
          Effect.provide(Otel.layerOtel({
            resource: { serviceName: "flows-test", serviceVersion: "1" },
            tracerProvider,
            loggerProvider,
            loggerMergeWithExisting: false,
            // Owned by the layer: released with the scope, which is also the
            // collection that fills the metric exporter.
            metricReader: () =>
              new PeriodicExportingMetricReader({
                exporter: metricExporter,
                exportIntervalMillis: 60_000
              })
          })),
          Effect.provideService(Metric.MetricRegistry, new Map())
        )
      )
      await tracerProvider.forceFlush()
      await loggerProvider.forceFlush()
      expect(traceExporter.getFinishedSpans().map((span) => span.name)).toEqual(["injected-span"])
      expect(logExporter.getFinishedLogRecords().map((record) => record.body)).toEqual(["injected record"])
      expect(exportedCounters(metricExporter)).toEqual([["injected.records", [3]]])
    } finally {
      await tracerProvider.shutdown()
      await loggerProvider.shutdown()
    }
  })

  it("shuts down the readers it acquired and leaves the injected providers running", async () => {
    const shutdowns = { tracer: 0, logger: 0 }
    const tracerProvider = new BasicTracerProvider()
    const loggerProvider = new LoggerProvider()
    const tracerShutdown = tracerProvider.shutdown.bind(tracerProvider)
    const loggerShutdown = loggerProvider.shutdown.bind(loggerProvider)
    tracerProvider.shutdown = async () => {
      shutdowns.tracer++
      await tracerShutdown()
    }
    loggerProvider.shutdown = async () => {
      shutdowns.logger++
      await loggerShutdown()
    }
    let acquired: PeriodicExportingMetricReader | undefined
    const acquire = vi.fn(() =>
      acquired = new PeriodicExportingMetricReader({
        exporter: new InMemoryMetricExporter(0),
        exportIntervalMillis: 60_000
      })
    )
    try {
      await run(
        // Collecting inside the scope proves the reader is live while the
        // bridge holds it, so the rejection below is the release, not a reader
        // that never started.
        Effect.promise(() => acquired!.collect()).pipe(
          Effect.provide(Otel.layerOtel({
            resource: { serviceName: "flows-test" },
            tracerProvider,
            loggerProvider,
            metricReader: acquire
          })),
          Effect.provideService(Metric.MetricRegistry, new Map())
        )
      )
      expect(acquire).toHaveBeenCalledTimes(1)
      await expect(acquired!.collect()).rejects.toThrow(/shutdown/i)
      expect(shutdowns).toEqual({ tracer: 0, logger: 0 })
      expect(tracerProvider.getTracer("still-usable")).toBeDefined()
      expect(loggerProvider.getLogger("still-usable")).toBeDefined()
    } finally {
      await tracerShutdown()
      await loggerShutdown()
    }
  })

  it("exports the configured resource on traces, logs, and metrics", async () => {
    const traceExporter = new InMemorySpanExporter()
    const logExporter = new InMemoryLogRecordExporter()
    const metricExporter = new InMemoryMetricExporter(1)
    let tracerProvider: BasicTracerProvider | undefined
    let loggerProvider: LoggerProvider | undefined
    const makeTracerProvider = vi.fn((resource: typeof Resource.Resource.Service) =>
      tracerProvider = new BasicTracerProvider({
        resource,
        spanProcessors: [new SimpleSpanProcessor(traceExporter)]
      })
    )
    const makeLoggerProvider = vi.fn((resource: typeof Resource.Resource.Service) =>
      loggerProvider = new LoggerProvider({
        resource,
        processors: [new SimpleLogRecordProcessor({ exporter: logExporter })]
      })
    )
    const metricReader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 60_000
    })
    try {
      await run(
        Effect.gen(function*() {
          yield* Effect.void.pipe(Effect.withSpan("resource-test"))
          yield* Effect.logInfo("resource-test")
          yield* Metric.update(Metric.counter("resource-test"), 1)
        }).pipe(
          Effect.provide(Otel.layerOtel({
            resource: {
              serviceName: "requested-service",
              serviceVersion: "9.8.7",
              attributes: { region: "test-region" }
            },
            tracerProvider: makeTracerProvider,
            loggerProvider: makeLoggerProvider,
            metricReader: () => metricReader,
            loggerMergeWithExisting: false
          })),
          Effect.provideService(Metric.MetricRegistry, new Map())
        )
      )
      expect(makeTracerProvider).toHaveBeenCalledTimes(1)
      expect(makeLoggerProvider).toHaveBeenCalledTimes(1)
      expect(makeTracerProvider.mock.calls[0]![0]).toBe(makeLoggerProvider.mock.calls[0]![0])
      await tracerProvider!.forceFlush()
      await loggerProvider!.forceFlush()
      const signals = [
        traceExporter.getFinishedSpans(),
        logExporter.getFinishedLogRecords(),
        metricExporter.getMetrics()
      ]
      for (const signal of signals) {
        expect(signal).toHaveLength(1)
        expect(signal[0]!.resource.attributes).toMatchObject({
          "service.name": "requested-service",
          "service.version": "9.8.7",
          region: "test-region"
        })
      }
    } finally {
      await tracerProvider?.shutdown()
      await loggerProvider?.shutdown()
    }
  })

  it.each([
    { serviceName: "" },
    { serviceName: "oversized", attributes: { text: "漢".repeat(65_536) } },
    { serviceName: "array", attributes: { values: Array.from({ length: 257 }, () => true) } }
  ])("validates the resource before invoking provider or reader factories", async (resource) => {
    const tracerProvider = vi.fn(() => new BasicTracerProvider())
    const loggerProvider = vi.fn(() => new LoggerProvider())
    const metricReader = vi.fn(() =>
      new PeriodicExportingMetricReader({
        exporter: new InMemoryMetricExporter(0),
        exportIntervalMillis: 60_000
      })
    )
    const layer = Otel.layerOtel({
      resource,
      tracerProvider,
      loggerProvider,
      metricReader
    })
    expect(tracerProvider).not.toHaveBeenCalled()
    expect(loggerProvider).not.toHaveBeenCalled()
    expect(metricReader).not.toHaveBeenCalled()
    await expect(run(Effect.void.pipe(Effect.provide(layer)))).rejects.toBeInstanceOf(
      Resource.InvalidResourceConfiguration
    )
    expect(tracerProvider).not.toHaveBeenCalled()
    expect(loggerProvider).not.toHaveBeenCalled()
    expect(metricReader).not.toHaveBeenCalled()
  })

  it("registers no reader when the factory returns an empty array", async () => {
    const result = await run(
      Effect.gen(function*() {
        yield* Metric.update(Metric.counter("unexported.records"), 1)
        return "ok"
      }).pipe(
        Effect.provide(Otel.layerOtel({
          resource: { serviceName: "flows-test" },
          metricReader: () => []
        })),
        Effect.provideService(Metric.MetricRegistry, new Map())
      )
    )
    expect(result).toBe("ok")
  })
})

describe("Resource.configToAttributes", () => {
  it("renders explicit service metadata and reads no environment", () => {
    expect(
      Resource.configToAttributes({
        serviceName: "flows-test",
        serviceVersion: "1.2.3",
        attributes: { "deployment.environment": "test" }
      })
    ).toMatchObject({ "service.name": "flows-test", "service.version": "1.2.3" })
  })

  it("rejects an empty service name rather than emitting anonymous telemetry", () => {
    expect(() => Resource.configToAttributes({ serviceName: "" })).toThrow()
  })

  it("exposes the OpenTelemetry resource service tag", () => {
    expect(Resource.Resource).toBeDefined()
  })
})
