import type { Collection } from "@smthrs/effect-tanstack-db"
import { Effect, Metric, Option } from "effect"
import { codeOf } from "../../errorCode"
import { draftWrites } from "./metrics"
import { type ChatDraft, HOME_DRAFT } from "./schema"

// A draft whose save is still pending must be distinguishable from a failed device write. The transaction id joins
// its stages; records contain neither draft text nor a storage error's message.
export const persistDraft = (write: Collection.Transaction, key: string) => {
  const count = (stage: string) => Metric.update(Metric.withAttributes(draftWrites, { stage }), 1)
  return Effect.gen(function* () {
    yield* count("waiting")
    yield* Effect.logInfo("chat draft saving")
    yield* write.persisted.pipe(
      Effect.tap(() => Effect.andThen(count("stored"), Effect.logInfo("chat draft stored"))),
      Effect.tapError((failure) =>
        Effect.andThen(
          count("failed"),
          Effect.logWarning("chat draft failed").pipe(Effect.annotateLogs({ outcome: "failed", errorCode: codeOf(failure) })),
        )
      ),
    )
  }).pipe(
    Effect.annotateLogs({ feature: "chat", transactionId: write.id, conversation: key === HOME_DRAFT ? "home" : "branch" }),
    // A storage error can quote row content. End the span with an outcome, so its exception exporter never sees it;
    // restore the original typed failure only after that span has ended.
    Effect.result,
    Effect.tap((outcome) => Effect.annotateCurrentSpan({ outcome: outcome._tag })),
    Effect.withSpan("chat.draft.save"),
    Effect.flatMap((outcome) => outcome._tag === "Success" ? Effect.void : Effect.fail(outcome.failure)),
  )
}

/**
 * Keeps a question taken back as the draft of conversation `key`, the one it was asked in, and succeeds once the device
 * has stored it. A draft already kept with the same text stays as it is, with its generation; a replaced or new one has
 * none, so it never inherits another draft's identity.
 */
export const saveTakenBack = (drafts: Collection.Collection<ChatDraft, string>, key: string, text: string) =>
  Effect.gen(function* () {
    const kept = yield* drafts.get(key)
    if (Option.isSome(kept) && kept.value.text === text) return
    const write = Option.isSome(kept)
      ? yield* drafts.update(key, (row) => { row.text = text; delete row.generation })
      : yield* drafts.insert({ id: key, text })
    yield* persistDraft(write, key)
  })
