import * as OtelResource from "@effect/opentelemetry/Resource"
import * as OtlpResource from "effect/unstable/observability/OtlpResource"
import * as Resource from "../../src/Resource.ts"

/** Measure the actual upstream OTLP representation independently of admission. */
export const resourceBytes = (configuration: Resource.Configuration): number =>
  new TextEncoder().encode(JSON.stringify(OtlpResource.make(configuration))).byteLength

/** Measure the SDK's complete resource, including its added telemetry fields. */
export const sdkResourceBytes = (configuration: Resource.Configuration): number =>
  new TextEncoder().encode(JSON.stringify({
    attributes: OtlpResource.entriesToAttributes(
      Object.entries(OtelResource.configToAttributes(Resource.toOpenTelemetryConfiguration(configuration)))
    ),
    droppedAttributesCount: 0
  })).byteLength

/** Representative resources padded to the exact cumulative admission boundary. */
export const boundaryResources = [
  { serviceName: "ascii", attributes: { text: "x".repeat(60_000) } },
  { serviceName: "escaped", attributes: { text: "\u0001\"\\".repeat(8_000) } },
  { serviceName: "unicode", attributes: { text: "漢😀".repeat(10_000) } },
  {
    serviceName: "\u0001".repeat(Resource.maximumIdentityLength),
    serviceVersion: "\u0002".repeat(Resource.maximumIdentityLength),
    attributes: Object.fromEntries(Array.from({ length: 12 }, (_, i) => ["\u0003".repeat(1_020) + i, "漢"]))
  },
  {
    serviceName: "arrays",
    attributes: {
      strings: Array.from({ length: Resource.maximumAttributeArrayLength }, () => "é".repeat(100)),
      numbers: [1, 0.5, -1, Number.MAX_VALUE],
      booleans: [true, false]
    }
  }
].map((configuration) => {
  const padded = {
    serviceVersion: "1.0.0-rc.0",
    ...configuration,
    attributes: { ...configuration.attributes, paddingA: "", paddingB: "" }
  }
  // The SDK representation is larger than the default exporter's for these
  // fixtures, so pad its actual projected resource to the complete byte limit.
  const remaining = Resource.maximumResourceBytes - sdkResourceBytes(padded)
  padded.attributes.paddingA = "x".repeat(Math.min(remaining, Resource.maximumAttributeStringLength))
  padded.attributes.paddingB = "x".repeat(Math.max(0, remaining - Resource.maximumAttributeStringLength))
  return padded
})
