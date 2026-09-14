import { ConfigProvider, Effect, Logger, Metric } from "effect"
import * as OtlpResource from "effect/unstable/observability/OtlpResource"
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http"
import { createRequire, syncBuiltinESMExports } from "node:module"
import { Readable, Writable } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import * as NodeOtel from "../src/NodeOtel.ts"
import * as Otlp from "../src/Otlp.ts"
import * as Resource from "../src/Resource.ts"
import { boundaryResources } from "./fixtures/resources.ts"

type Body = Record<string, Array<{ resource: { attributes: Array<{ key: string; value: unknown }> } }>>
// The SDK dynamically imports native http outside Vitest's module wrappers.
const http: typeof import("node:http") = createRequire(import.meta.url)("node:http")

describe("NodeOtel resource admission", () => {
  it.each([
    ...["provider", "environment"].map((source) => ({
      source,
      name: "small resource",
      resource: { serviceName: "review-node", attributes: { explicit: "retained" } }
    })),
    ...boundaryResources.map((resource, index) => ({ source: "provider", name: `boundary ${index}`, resource }))
  ])("isolates ambient metadata from every signal via $source with $name", async ({ source, resource }) => {
    const requests: Array<{ path: string; bytes: number; body: Body }> = []
    // Keep the real SDK processors, serializers and HTTP transport. Replace
    // only the socket boundary with a recording writable and an HTTP response.
    const request = vi.spyOn(http, "request").mockImplementation(
      (
        (url: URL, _options: RequestOptions, respond: (response: IncomingMessage) => void) => {
          const chunks: Array<Buffer> = []
          const sink = new Writable({
            write(chunk: Buffer, _encoding, done) {
              chunks.push(Buffer.from(chunk))
              done()
            },
            final(done) {
              const body = Buffer.concat(chunks)
              requests.push({ path: url.pathname, bytes: body.byteLength, body: JSON.parse(body.toString("utf8")) })
              const response = Object.assign(Readable.from([Buffer.from("{}")]), { statusCode: 200, headers: {} })
              respond(response as IncomingMessage)
              done()
            }
          })
          return Object.assign(sink, { setTimeout: () => sink }) as unknown as ClientRequest
        }
      ) as typeof http.request
    )
    syncBuiltinESMExports()
    const ambient = {
      OTEL_SERVICE_NAME: "ambient-service",
      OTEL_RESOURCE_ATTRIBUTES: [
        "service.version=ambient-version",
        ...Array.from({ length: 17 }, (_, i) => `ambient-${i}=${"x".repeat(65_536)}`)
      ].join(",")
    }
    try {
      if (source === "environment") {
        for (const [key, value] of Object.entries(ambient)) vi.stubEnv(key, value)
      }
      const program = Effect.gen(function*() {
        yield* Effect.void.pipe(Effect.withSpan("resource-span"))
        yield* Effect.logInfo("resource log")
        yield* Metric.update(Metric.counter("resource.records"), 1)
      }).pipe(
        Effect.provide(NodeOtel.layerOtel({
          endpoint: "http://collector.invalid",
          resource,
          exportIntervalMillis: 60_000,
          shutdownTimeout: "10 seconds"
        })),
        Effect.provideService(Metric.MetricRegistry, new Map()),
        Effect.provide(Logger.layer([])),
        Effect.scoped
      )
      // Scope release force-flushes all three signals, so no timers or polling
      // are needed to know when the recording transport has received them.
      await Effect.runPromise(
        source === "provider"
          ? program.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(ambient))))
          : program
      )
      expect(requests.map((request) => request.path).sort()).toEqual(["/v1/logs", "/v1/metrics", "/v1/traces"])
      const expectedAttributes = Resource.configToAttributes(resource)
      expect(
        requests.filter((request) => request.bytes > Otlp.maxRequestBytes).map(({ path, bytes }) => ({ path, bytes }))
      )
        .toEqual([])
      for (const request of requests) {
        expect(request.bytes, request.path).toBeLessThanOrEqual(Otlp.maxRequestBytes)
        const exported = Object.values(request.body)[0]![0]!.resource
        expect(Buffer.byteLength(JSON.stringify(exported))).toBeLessThanOrEqual(Resource.maximumResourceBytes)
        expect(Object.fromEntries(exported.attributes.map(({ key, value }) => [key, value]))).toEqual(
          Object.fromEntries(
            OtlpResource.entriesToAttributes(Object.entries(expectedAttributes)).map(
              ({ key, value }) => [key, value]
            )
          )
        )
      }
    } finally {
      request.mockRestore()
      syncBuiltinESMExports()
      vi.unstubAllEnvs()
    }
  })
})
