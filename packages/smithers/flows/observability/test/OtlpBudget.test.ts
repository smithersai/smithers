import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Logger, Metric } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as Otlp from "../src/Otlp.ts"
import * as Resource from "../src/Resource.ts"
import { boundaryResources } from "./fixtures/resources.ts"

type Body = Record<
  string,
  Array<{
    resource: unknown
    scopeLogs?: Array<{ scope: unknown; logRecords: Array<unknown> }>
    scopeSpans?: Array<{ scope: unknown; spans: Array<unknown> }>
    scopeMetrics?: Array<{ scope: unknown; metrics: Array<unknown> }>
  }>
>
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength

const scopeCandidates = [
  {
    serviceName: "alias",
    serviceVersion: "v1",
    attributes: { "service.name": "a".repeat(60_000) }
  },
  { serviceName: "escaped-alias", attributes: { "service.name": "\u0001".repeat(20_000) } }
]

describe("OTLP usable signal capacity", () => {
  it.effect.each(boundaryResources.map((resource, index) => ({ resource, index })))(
    "exports ordinary 1,000-record log and span batches at resource boundary $index",
    ({ resource }) =>
      Effect.gen(function*() {
        const requests: Array<{ url: string; body: Body }> = []
        const registry = new Map()
        const batchesReceived = yield* Deferred.make<void>()
        let receivedBatches = 0
        yield* Effect.gen(function*() {
          for (let index = 0; index < 1000; index++) {
            yield* Effect.logInfo("normal log with room for application details").pipe(
              Effect.annotateLogs({ phase: "running", attempt: 1 })
            )
            yield* Effect.void.pipe(Effect.withSpan("normal-span", { attributes: { phase: "running", attempt: 1 } }))
          }
          // Full batches fork upstream. Keep the scope alive until both requests
          // reach the recording transport, independently of scheduler speed.
          yield* Deferred.await(batchesReceived)
          yield* Metric.update(Metric.counter("resource_budget_counter"), 1)
        }).pipe(
          Effect.provide(
            Otlp.layerFetch({ ...resource, baseUrl: "http://collector.invalid", exportInterval: "1 hour" })
          ),
          Effect.provideService(FetchHttpClient.Fetch, async (input, init) => {
            requests.push({ url: String(input), body: JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) })
            if (!String(input).endsWith("/v1/metrics") && ++receivedBatches === 2) {
              Effect.runSync(Deferred.succeed(batchesReceived, undefined))
            }
            return new Response("{}", { status: 200 })
          }),
          Effect.provideService(Metric.MetricRegistry, registry),
          Effect.provide(Logger.layer([]))
        )
        expect(requests.map((request) => new URL(request.url).pathname).sort()).toEqual([
          "/v1/logs",
          "/v1/metrics",
          "/v1/traces"
        ])
        for (const request of requests) {
          expect(bytes(request.body)).toBeLessThanOrEqual(Otlp.maxRequestBytes)
          const group = Object.values(request.body)[0]![0]!
          if (group.scopeLogs) expect(group.scopeLogs[0]!.logRecords).toHaveLength(1000)
          if (group.scopeSpans) expect(group.scopeSpans[0]!.spans).toHaveLength(1000)
          if (group.scopeLogs) group.scopeLogs[0]!.logRecords = []
          if (group.scopeSpans) group.scopeSpans[0]!.spans = []
          if (group.scopeMetrics) group.scopeMetrics[0]!.metrics = []
          expect(bytes(request.body) + Otlp.reservedBatchBytes).toBeLessThanOrEqual(Otlp.maxRequestBytes)
          group.resource = undefined
          expect(bytes(request.body)).toBeLessThanOrEqual(Otlp.maximumEnvelopeBytes)
        }
        const dropped = yield* Metric.value(Metric.counter("flows/observability/otlp/dropped")).pipe(
          Effect.provideService(Metric.MetricRegistry, registry)
        )
        expect(dropped.count).toBe(0)
      })
  )

  it.effect.each(scopeCandidates)(
    "accounts for the effective scope name of $serviceName",
    (resource) =>
      Effect.gen(function*() {
        expect(yield* Resource.decode(resource)).toEqual(resource)
        const requests: Array<Body> = []
        yield* Effect.gen(function*() {
          yield* Effect.logInfo("small log")
          yield* Effect.void.pipe(Effect.withSpan("small span"))
          yield* Metric.update(Metric.counter("scope_budget_counter"), 1)
        }).pipe(
          Effect.provide(
            Otlp.layerFetch({ ...resource, baseUrl: "http://collector.invalid", exportInterval: "1 hour" })
          ),
          Effect.provideService(FetchHttpClient.Fetch, async (_input, init) => {
            requests.push(JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)))
            return new Response("{}", { status: 200 })
          }),
          Effect.provideService(Metric.MetricRegistry, new Map()),
          Effect.provide(Logger.layer([]))
        )
        expect(requests).toHaveLength(3)
        for (const body of requests) {
          const group = Object.values(body)[0]![0]!
          const scope = group.scopeLogs?.[0]?.scope ?? group.scopeSpans?.[0]?.scope ?? group.scopeMetrics?.[0]?.scope
          expect(scope).toEqual({ name: resource.serviceName })
          if (group.scopeLogs) group.scopeLogs[0]!.logRecords = []
          if (group.scopeSpans) group.scopeSpans[0]!.spans = []
          if (group.scopeMetrics) group.scopeMetrics[0]!.metrics = []
          expect(bytes(body) + Otlp.reservedBatchBytes).toBeLessThanOrEqual(Otlp.maxRequestBytes)
        }
      })
  )
})
