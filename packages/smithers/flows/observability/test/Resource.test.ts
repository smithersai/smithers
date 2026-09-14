import { Cause, Effect, Layer, Result, Schema } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { describe, expect, it } from "vitest"
import * as BrowserOtel from "../src/BrowserOtel.ts"
import * as NodeOtel from "../src/NodeOtel.ts"
import * as Otel from "../src/Otel.ts"
import * as Otlp from "../src/Otlp.ts"
import * as Resource from "../src/Resource.ts"
import { boundaryResources, resourceBytes, sdkResourceBytes } from "./fixtures/resources.ts"

const failureOf = async <A, E>(layer: Layer.Layer<A, E>) => {
  const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(layer)))
  expect(exit._tag).toBe("Failure")
  if (exit._tag === "Success") throw new Error("expected resource refusal")
  const failure = Result.getOrUndefined(Cause.findError(exit.cause))
  expect(failure).toBeInstanceOf(Resource.InvalidResourceConfiguration)
  return failure as Resource.InvalidResourceConfiguration
}

const layersFor = (resource: unknown) => {
  const configuration = resource as {
    readonly serviceName?: string
    readonly serviceVersion?: string
    readonly attributes?: Record<string, unknown>
  }
  return [
    Resource.layer(resource as never),
    Otel.layerOtel({ resource: resource as never }),
    BrowserOtel.layerOtel({ resource: resource as never }),
    NodeOtel.layerOtel({ endpoint: "http://127.0.0.1:4318", resource: resource as never }),
    Otlp.layer({ baseUrl: "http://127.0.0.1:4318", ...configuration }).pipe(Layer.provide(FetchHttpClient.layer)),
    Otlp.layerFetch({
      baseUrl: "http://127.0.0.1:4318",
      ...(configuration.serviceName === undefined ? {} : { serviceName: configuration.serviceName }),
      ...(configuration.serviceVersion === undefined ? {} : { serviceVersion: configuration.serviceVersion }),
      ...(configuration.attributes === undefined ? {} : { attributes: configuration.attributes })
    })
  ] as const
}

describe("Resource configuration", () => {
  it("gives every public layer the same rejection and offending path", async () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: Resource.maximumAttributes + 1 }, (_, index) => [`key-${index}`, index])
    )
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ["serviceName", { serviceName: "" }],
      ["serviceName", { serviceName: "\ud800" }],
      ["serviceVersion", { serviceName: "service", serviceVersion: `v${String.fromCharCode(0)}1` }],
      ["attributes.bad", { serviceName: "service", attributes: { bad: {} } }],
      ["attributes.bad", { serviceName: "service", attributes: { bad: Number.NaN } }],
      ["attributes.bad", { serviceName: "service", attributes: { bad: ["one", 2] } }],
      ["attributes", { serviceName: "service", attributes: tooMany }]
    ]

    for (const [path, configuration] of cases) {
      for (const layer of layersFor(configuration)) {
        const failure = await failureOf(layer)
        expect(failure.code).toBe("invalid_resource_configuration")
        expect(failure.path).toContain(path)
        expect(failure.message).not.toContain(JSON.stringify(configuration))
      }
      expect(() => Resource.configToAttributes(configuration as never)).toThrow(
        Resource.InvalidResourceConfiguration
      )
    }
  })

  it("accepts well-formed astral text and every supported attribute shape", async () => {
    const configuration = {
      serviceName: "service-😀",
      serviceVersion: "v1",
      attributes: {
        text: "hello-😀",
        number: 42,
        enabled: true,
        texts: ["a", "b"],
        numbers: [1, 2],
        booleans: [true, false],
        empty: []
      }
    } as const
    for (const layer of layersFor(configuration)) {
      const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(layer)))
      expect(exit._tag).toBe("Success")
    }
    expect(Resource.configToAttributes(configuration)).toMatchObject({
      "service.name": "service-😀",
      "service.version": "v1",
      text: "hello-😀"
    })
  })

  it("accepts exact resource ceilings and rejects the next value", async () => {
    const exact = {
      serviceName: "s".repeat(Resource.maximumIdentityLength),
      attributes: {
        ["k".repeat(Resource.maximumAttributeKeyLength)]: "v".repeat(Resource.maximumAttributeStringLength)
      }
    }
    expect(await Effect.runPromise(Resource.decode(exact))).toMatchObject({ serviceName: exact.serviceName })

    for (
      const candidate of [
        { ...exact, serviceName: `${exact.serviceName}x` },
        { serviceName: "s", attributes: { [`${Object.keys(exact.attributes)[0]}x`]: "v" } },
        { serviceName: "s", attributes: { key: `${Object.values(exact.attributes)[0]}x` } }
      ]
    ) {
      const exit = await Effect.runPromiseExit(Resource.decode(candidate))
      expect(exit._tag).toBe("Failure")
    }
  })

  it("refuses aggregate and encoded size violations at every acquisition and decoding entry point", async () => {
    const secret = "PRIVATE_RESOURCE_VALUE"
    const cases = [
      {
        attributes: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`key-${i}`, secret + "x".repeat(4_096)]))
      },
      { attributes: { array: Array.from({ length: 40 }, () => secret + "x".repeat(4_096)) } },
      { attributes: { text: secret + "\u0001".repeat(25_000) } },
      { attributes: { text: secret + "漢".repeat(45_000) } },
      { attributes: { text: secret + "😀".repeat(32_000), second: "😀".repeat(1_000) } },
      { attributes: Object.fromEntries(Array.from({ length: 24 }, (_, i) => ["\u0001".repeat(1_020) + i, secret])) }
    ]
    for (const candidate of cases) {
      const configuration = { serviceName: "service", serviceVersion: Otlp.defaultServiceVersion, ...candidate }
      // Each field passes its local schema; the combined encoded resource does not.
      expect(Schema.decodeUnknownSync(Resource.Attributes)(configuration.attributes)).toEqual(configuration.attributes)
      const measured = sdkResourceBytes(configuration)
      expect(measured).toBeGreaterThan(Resource.maximumResourceBytes)
      const assertRefusal = (error: unknown) => {
        expect(error).toBeInstanceOf(Resource.InvalidResourceConfiguration)
        const refusal = error as Resource.InvalidResourceConfiguration
        expect(refusal.path).toBe("attributes")
        expect(refusal.message).toContain(`${Resource.maximumResourceBytes} byte limit`)
        const lowerBound = Number(/at least (\d+) bytes/.exec(refusal.message)?.[1])
        expect(lowerBound).toBeGreaterThan(Resource.maximumResourceBytes)
        expect(lowerBound).toBeLessThanOrEqual(measured)
        expect(JSON.stringify(refusal)).not.toContain(secret)
        expect(refusal.message).not.toContain("\u0001")
      }
      for (const layer of layersFor(configuration)) assertRefusal(await failureOf(layer))
      const decoded = await Effect.runPromise(Effect.result(Resource.decode(configuration)))
      expect(decoded._tag).toBe("Failure")
      if (decoded._tag === "Failure") assertRefusal(decoded.failure)
      for (const decode of [Resource.decodeSync, Resource.configToAttributes]) {
        let refusal: unknown
        try {
          decode(configuration)
        } catch (error) {
          refusal = error
        }
        assertRefusal(refusal)
      }
    }
  })

  it.each(["\u0001", "漢", "😀"])("counts encoding expansion for %j even below the character budget", (character) => {
    const configuration = {
      serviceName: "service",
      attributes: { text: character.repeat(32_768), extra: character.repeat(16_384) }
    }
    expect(configuration.attributes.text.length).toBeLessThanOrEqual(Resource.maximumAttributeStringLength)
    expect(configuration.attributes.text.length + configuration.attributes.extra.length).toBeLessThan(
      Resource.maximumResourceBytes
    )
    expect(resourceBytes(configuration)).toBeGreaterThan(Resource.maximumResourceBytes)
    expect(() => Resource.decodeSync(configuration)).toThrow(Resource.InvalidResourceConfiguration)
  })

  it("bounds every homogeneous array and reports its path, measured length and limit without values", async () => {
    for (const element of ["PRIVATE_ARRAY_VALUE", 3, true]) {
      const exact = Array.from({ length: Resource.maximumAttributeArrayLength }, () => element)
      expect(Schema.decodeUnknownSync(Resource.AttributeValue)(exact)).toEqual(exact)
      const oversized = [...exact, element]
      expect(() => Schema.decodeUnknownSync(Resource.AttributeValue)(oversized)).toThrow()
      const configuration = { serviceName: "service", attributes: { array: oversized } }
      for (const layer of layersFor(configuration)) {
        const failure = await failureOf(layer)
        expect(failure.path).toBe("attributes.array")
        expect(failure.message).toContain("257 elements")
        expect(failure.message).toContain("256 element limit")
        expect(JSON.stringify(failure)).not.toContain("PRIVATE_ARRAY_VALUE")
      }
    }
  })

  it.each(boundaryResources)(
    "accepts exact encoded boundaries and refuses one more byte: $serviceName",
    async (configuration) => {
      expect(sdkResourceBytes(configuration)).toBe(Resource.maximumResourceBytes)
      expect(resourceBytes(configuration)).toBeLessThanOrEqual(Resource.maximumResourceBytes)
      expect(Resource.decodeSync(configuration)).toEqual(configuration)
      const oversized = {
        ...configuration,
        attributes: { ...configuration.attributes, paddingB: configuration.attributes.paddingB + "x" }
      }
      expect(sdkResourceBytes(oversized)).toBe(Resource.maximumResourceBytes + 1)
      expect(() => Resource.decodeSync(oversized)).toThrow(Resource.InvalidResourceConfiguration)
      expect(() => Resource.configToAttributes(oversized)).toThrow(Resource.InvalidResourceConfiguration)
      await expect(Effect.runPromise(Resource.decode(oversized))).rejects.toBeInstanceOf(
        Resource.InvalidResourceConfiguration
      )
      for (const layer of layersFor(oversized)) expect((await failureOf(layer)).path).toBe("attributes")
    }
  )

  it("omits absent optional fields in the SDK projection", () => {
    expect(Resource.toOpenTelemetryConfiguration({ serviceName: "service" })).toEqual({
      serviceName: "service"
    })
  })

  it("attributes a top-level malformed configuration without retaining it", async () => {
    const exit = await Effect.runPromiseExit(Resource.decode(null))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const failure = Result.getOrUndefined(Cause.findError(exit.cause))
      expect(failure).toMatchObject({
        code: "invalid_resource_configuration",
        path: "resource",
        message: "OpenTelemetry resource resource is invalid"
      })
    }
  })
})
