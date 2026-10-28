import { Effect, Exit, Option } from "effect"
import { setDraft } from "./features/chat/actions"
import { COMPOSER, HOME_DRAFT, PLACE } from "./features/chat/schema"
import { ChatStore } from "./features/chat/store"
import { admissionReceipt, WriteIntents, type WriteIntent } from "./writeAdmission"

/** Admission and Retry share the same source cleanup, including its actual persistence receipt. */
export const clearComposerSource = (source: NonNullable<WriteIntent["composer"]>) => Effect.gen(function* () {
  const chat = yield* Effect.serviceOption(ChatStore)
  if (Option.isNone(chat)) return false
  const store = chat.value
  const matches = (generation: string | undefined) => generation === source.generation
  yield* store.drafts.restored
  const place = Option.getOrThrow(yield* store.place.get(PLACE))
  const composer = Option.getOrThrow(yield* store.composer.get(COMPOSER))
  if (place.conversationId === source.conversationId && composer.draft === source.text && matches(composer.generation)) {
    yield* setDraft("", undefined, true).pipe(Effect.provideService(ChatStore, store))
  }
  const key = source.conversationId ?? HOME_DRAFT
  const pending = yield* store.drafts.pendingWrites(key)
  yield* Effect.all(pending.map(write => write.persisted))
  // A newer edit can arrive while those receipts wait. Retain cleanup until a subsequent recovery confirms it.
  if ((yield* store.drafts.pendingWrites(key)).length !== 0) return false
  const draft = yield* store.drafts.get(key)
  if (Option.isSome(draft)) {
    if (draft.value.text === source.text && matches(draft.value.generation)) {
      yield* store.drafts.delete(key).pipe(Effect.flatMap(write => write.persisted))
    } else if (!(yield* store.drafts.isSynced(key))) return false
  }
  // Optimistic replacement text cannot prove the submitted source is gone from disk yet.
  const latest = Option.getOrThrow(yield* store.composer.get(COMPOSER))
  const current = Option.getOrThrow(yield* store.place.get(PLACE))
  return current.conversationId !== source.conversationId || latest.saved

}).pipe(Effect.exit, Effect.map(exit => Exit.isSuccess(exit) && exit.value))

/** A non-composer write needs no composer services. Never retire a source that could not confirm cleanup. */
export const clearWriteComposer = (writeId: string) => Effect.gen(function* () {
  const intents = yield* Effect.serviceOption(WriteIntents)
  if (Option.isNone(intents)) return true
  const intent = intents.value.pending().find(row => row.writeId === writeId || intents.value.byWrite.get(writeId) === row.commandId)
  if (intent?.composer === undefined) return true
  return yield* admissionReceipt(clearComposerSource(intent.composer).pipe(
    Effect.flatMap(confirmed => confirmed ? Effect.void : Effect.fail("unconfirmed")),
  ), intent.commandId, intent.flow, "source").pipe(Effect.as(true), Effect.orElseSucceed(() => false))
})
