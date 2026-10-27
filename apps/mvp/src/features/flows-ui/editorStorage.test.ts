import { Effect, Logger } from "effect"
import { expect, test } from "vitest"
import { restoreEditorCollection } from "./editorStorage"

test.each(["flow-form", "flow-answers", "flow-code"] as const)("%s records success, error and timeout without content", async (collection) => {
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect.pipe(
    Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((entry) => void logs.push(Logger.formatStructured.log(entry)))])),
  ))
  expect((await run(restoreEditorCollection(collection, Effect.succeed("private text"), "1 second")))._tag).toBe("Success")
  expect((await run(restoreEditorCollection(collection, Effect.fail({ _tag: "StorageError", message: "private text" }), "1 second")))._tag).toBe("Failure")
  expect((await run(restoreEditorCollection(collection, Effect.never, "1 millis")))._tag).toBe("Failure")
  expect(logs.map((log) => log.annotations)).toEqual([
    { feature: "flows", collection, outcome: "restored" },
    { feature: "flows", collection, outcome: "failed", errorCode: "StorageError" },
    { feature: "flows", collection, outcome: "failed", errorCode: "TimeoutError" },
  ])
  expect(JSON.stringify(logs)).not.toContain("private text")
})
