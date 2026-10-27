import { Duration, Effect } from "effect"
import { codeOf } from "../../errorCode"

/** Restore receipts distinguish a slow device from a refused read without recording stored content. */
export const restoreEditorCollection = <A, E, R>(
  collection: "flow-form" | "flow-answers" | "flow-code",
  restore: Effect.Effect<A, E, R>,
  within: Duration.Input,
) => Effect.gen(function* () {
  const ready = yield* Effect.result(restore.pipe(Effect.timeout(within)))
  if (ready._tag === "Failure") {
    yield* Effect.logWarning("flows.editor.storage").pipe(Effect.annotateLogs({
      feature: "flows", collection, outcome: "failed", errorCode: codeOf(ready.failure),
    }))
  } else {
    yield* Effect.logInfo("flows.editor.storage").pipe(Effect.annotateLogs({
      feature: "flows", collection, outcome: "restored",
    }))
  }
  return ready
})
