/**
 * An applier can exhaust the engine's argument limit on a real, large hunk.
 * Its unexpected failure remains diagnostic data rather than model output.
 */
import { Effect, Layer, Logger } from "effect"
import { expect, it } from "vitest"
import * as ApplyPatch from "../src/ApplyPatch.ts"
import { layer } from "./TestLayers.ts"

it("reports a real oversized applier call without exposing its engine exception", async () => {
  const logged: Array<unknown> = []
  const logger = Logger.make((options) => {
    if (options.logLevel === "Error") logged.push(options.message)
  })
  const input = "*** Begin Patch\n*** Update File: /a.txt\n@@\n-old\n"
    + "+new\n".repeat(200_000) + "*** End Patch"
  const failure = await Effect.runPromise(
    Effect.flip(ApplyPatch.run({ input })).pipe(
      Effect.provide(Layer.merge(layer({ files: { "/a.txt": "old\n" } }), Logger.layer([logger])))
    )
  )
  expect(failure).toMatchObject({
    code: "command_failed",
    message: "Something went wrong on our side. Not your fault.",
    path: "/a.txt"
  })
  expect(JSON.stringify(failure)).not.toContain("RangeError")
  expect(logged.flat()).toContain("apply_patch failed unexpectedly")
  expect(logged.flat().some((message) => message instanceof RangeError)).toBe(true)
})
