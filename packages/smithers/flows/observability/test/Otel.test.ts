import { Effect, Logger, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as Otel from "../src/Otel.ts"
import * as Resource from "../src/Resource.ts"

describe("Otel", () => {
  it("provides the configured resource and preserves the ambient logger without injected providers", async () => {
    const messages: Array<unknown> = []
    const sink = Logger.make((options) => messages.push(options.message))
    const resource = await Effect.runPromise(
      Effect.gen(function*() {
        yield* Effect.logInfo("without an injected provider")
        return Option.getOrThrow(yield* Effect.serviceOption(Resource.Resource))
      }).pipe(
        Effect.provide(Otel.layerOtel({ resource: { serviceName: "flows-test", serviceVersion: "1" } })),
        Effect.provide(Logger.layer([sink])),
        Effect.scoped
      )
    )
    expect(resource.attributes).toMatchObject({ "service.name": "flows-test", "service.version": "1" })
    expect(messages).toEqual([["without an injected provider"]])
  })
})
