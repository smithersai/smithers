import * as OtelResource from "@effect/opentelemetry/Resource"
import { Effect, Layer, Schema } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as OtlpResource from "effect/unstable/observability/OtlpResource"
import { describe, expect, it } from "vitest"
import * as BrowserOtel from "../src/BrowserOtel.ts"
import * as NodeOtel from "../src/NodeOtel.ts"
import * as Otel from "../src/Otel.ts"
import * as Otlp from "../src/Otlp.ts"
import * as Resource from "../src/Resource.ts"
import { boundaryResources } from "./fixtures/resources.ts"

describe("resource scope and array admission", () => {
  it.each(boundaryResources.map((configuration, index) => ({ configuration, index })))(
    "includes SDK metadata in the admitted byte ceiling: $index",
    ({ configuration }) => {
      expect(Resource.decodeSync(configuration)).toEqual(configuration)
      // Measure the pinned SDK projection independently of admission, retaining
      // its telemetry.sdk fields instead of measuring only OtlpResource.make.
      const projected = {
        attributes: OtlpResource.entriesToAttributes(Object.entries(OtelResource.configToAttributes(configuration))),
        droppedAttributesCount: 0
      }
      expect(new TextEncoder().encode(JSON.stringify(projected)).byteLength).toBeLessThanOrEqual(
        Resource.maximumResourceBytes
      )
    }
  )

  it.each(["", false, 1, ["scope"], "a".repeat(60_000)].map((scopeName, index) => ({ scopeName, index })))(
    "preserves explicit identity precedence over an attribute of another shape: $index",
    async ({ scopeName }) => {
      const configuration = { serviceName: "service", attributes: { "service.name": scopeName } }
      // Every upstream exporter removes custom service.name before making its
      // resource; SDK projection also overwrites it with explicit serviceName.
      expect(Resource.decodeSync(configuration)).toEqual(configuration)
      expect(Resource.configToAttributes(configuration)["service.name"]).toBe("service")
      const layers = [
        Resource.layer(configuration),
        Otel.layerOtel({ resource: configuration }),
        BrowserOtel.layerOtel({ resource: configuration }),
        NodeOtel.layerOtel({ resource: configuration, endpoint: "http://collector.invalid" }),
        Otlp.layerFetch({ ...configuration, baseUrl: "http://collector.invalid" }),
        Otlp.layer({ ...configuration, baseUrl: "http://collector.invalid" }).pipe(Layer.provide(FetchHttpClient.layer))
      ]
      for (const layer of layers) {
        const exit = await Effect.runPromiseExit(
          Effect.scoped(Layer.build(layer)).pipe(
            Effect.provideService(FetchHttpClient.Fetch, async () => new Response("{}"))
          )
        )
        expect(exit._tag).toBe("Success")
      }
    }
  )

  it.each(["text", 1, true])("bounds arrays in the public AttributeValue schema for %j", (value) => {
    const decode = Schema.decodeUnknownSync(Resource.AttributeValue)
    expect(decode(Array.from({ length: Resource.maximumAttributeArrayLength }, () => value))).toHaveLength(
      Resource.maximumAttributeArrayLength
    )
    expect(() => decode(Array.from({ length: Resource.maximumAttributeArrayLength + 1 }, () => value))).toThrow()
  })
})
