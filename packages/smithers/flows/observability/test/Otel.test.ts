import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Otel from "../src/Otel.vibe"

describe("Otel", () => {
  it("composes a provider-neutral layer and releases it with scope", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        yield* Effect.logInfo("without an injected provider")
        return "ok"
      }).pipe(
        Effect.provide(Otel.layerOtel({ resource: { serviceName: "flows-test", serviceVersion: "1" } })),
        Effect.scoped
      )
    )
    expect(result).toBe("ok")
  })
})
