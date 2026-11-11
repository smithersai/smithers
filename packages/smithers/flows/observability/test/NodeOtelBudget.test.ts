import { ConfigProvider, Effect, Logger, Metric } from "effect"
import * as OtlpResource from "effect/observability/OtlpResource"
import { createServer } from "node:http"
import { describe, expect, it, vi } from "vitest"
import * as NodeOtel from "../src/NodeOtel.ts"
import * as Otlp from "../src/Otlp.ts"
import * as Resource from "../src/Resource.ts"
import { boundaryResources } from "./fixtures/resources.ts"

type Body = Record<string, Array<{ resource: { attributes: Array<{ key: string; value: unknown }> } }>>
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
    const server = createServer((request, response) => {
      const chunks: Array<Buffer> = []
      request.on("data", (chunk: Buffer) => chunks.push(chunk))
      request.on("end", () => {
        const body = Buffer.concat(chunks)
        requests.push({ path: request.url ?? "", bytes: body.byteLength, body: JSON.parse(body.toString("utf8")) })
        response.writeHead(200, { "content-type": "application/json" })
        response.end("{}")
      })
    })
    const ambient = {
      OTEL_SERVICE_NAME: "ambient-service",
      OTEL_RESOURCE_ATTRIBUTES: [
        "service.version=ambient-version",
        ...Array.from({ length: 17 }, (_, i) => `ambient-${i}=${"x".repeat(65_536)}`)
      ].join(",")
    }
    try {
      const port = await new Promise<number>((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => {
          const address = server.address()
          if (address === null || typeof address === "string") reject(new Error("collector has no TCP address"))
          else resolve(address.port)
        })
      })
      if (source === "environment") {
        for (const [key, value] of Object.entries(ambient)) vi.stubEnv(key, value)
      }
      const program = Effect.gen(function*() {
        yield* Effect.void.pipe(Effect.withSpan("resource-span"))
        yield* Effect.logInfo("resource log")
        yield* Metric.update(Metric.counter("resource.records"), 1)
      }).pipe(
        Effect.provide(NodeOtel.layerOtel({
          endpoint: `http://127.0.0.1:${port}`,
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
      await new Promise<void>((resolve) => server.close(() => resolve()))
      vi.unstubAllEnvs()
    }
  })
})
