import type { PendingSnapshot } from "@smthrs/platform-browser"
import { Uuid, WebCrypto } from "@smthrs/crypto"
import { Cause, Clock, Context, Effect, Exit, Layer, Metric, Option, Schema } from "effect"

/** Temporary input receipt; delivery and retries remain the durable outbox's responsibility. */
export const WriteIntent = Schema.Struct({
  commandId: Schema.String,
  flow: Schema.String,
  payload: Schema.Record(Schema.String, Schema.Unknown),
  identity: Schema.optional(Schema.Struct({ namespace: Schema.String.check(Schema.isUUID()), value: Schema.String })),
  draftId: Schema.optional(Schema.String),
  composer: Schema.optional(Schema.Struct({ conversationId: Schema.NullOr(Schema.String), text: Schema.String, generation: Schema.optional(Schema.String) })),
  executionId: Schema.optional(Schema.String),
  writeId: Schema.optional(Schema.String),
  admitted: Schema.optional(Schema.Boolean),
  cleaned: Schema.optional(Schema.Boolean),
  navigated: Schema.optional(Schema.Boolean),
})
export type WriteIntent = typeof WriteIntent.Type
const decode = Schema.decodeUnknownOption(Schema.Array(WriteIntent))

export class WriteIntents extends Context.Service<WriteIntents, {
  readonly pending: () => ReadonlyArray<WriteIntent>
  readonly retain: (intent: WriteIntent) => boolean
  readonly forget: (commandId: string) => boolean
  readonly update: (commandId: string, fields: Partial<WriteIntent>) => boolean
  readonly resumed: Map<string, string>
  readonly byWrite: Map<string, string>
  readonly admitting: Map<string, number>
}>()("@smthrs/mvp/WriteIntents") {
  static readonly layer = (snapshot?: PendingSnapshot.Service, writable = true) => Layer.sync(WriteIntents, () => {
    const pending = () => Option.getOrElse(decode(snapshot?.read()?.value), () => [])
    const retain = (intent: WriteIntent) => writable && (snapshot === undefined || snapshot.stage([...pending().filter(row => row.commandId !== intent.commandId), intent]) !== undefined)
    return {
      pending,
      retain,
      update: (commandId, fields) => {
        const intent = pending().find(row => row.commandId === commandId)
        return intent === undefined || retain({ ...intent, ...fields })
      },
      forget: commandId => {
        const held = snapshot?.read()
        if (held === undefined) return true
        const remaining = pending().filter(row => row.commandId !== commandId)
        if (remaining.length === 0) snapshot?.acknowledge(held.token)
        else snapshot?.stage(remaining)
        return !pending().some(row => row.commandId === commandId)
      },
      resumed: new Map<string, string>(),
      byWrite: new Map<string, string>(),
      admitting: new Map<string, number>(),
    }
  })
}

export const admissionStages = Metric.counter("smithers_write_admission_stages", { incremental: true })
/** Correlation and receipt timing only. Never annotate payloads, repository names or hash inputs. */
export const recordAdmission = (commandId: string, flow: string, stage: string, outcome: string, startedAt: number) => Effect.gen(function* () {
  const atMs = yield* Clock.currentTimeMillis
  yield* Metric.update(Metric.withAttributes(admissionStages, { flow, stage, outcome }), 1)
  yield* Effect.logInfo("write.admission").pipe(Effect.annotateLogs({ commandId, flow, stage, outcome, atMs, durationMs: atMs - startedAt }))
})

/** Compare the fields JSON storage retains; property order and omitted optional fields are immaterial. */
const samePayload = (left: Readonly<Record<string, unknown>>, right: Readonly<Record<string, unknown>>) => {
  const fields = Object.entries(right).filter(([, value]) => value !== undefined)
  return Object.values(left).filter(value => value !== undefined).length === fields.length && fields.every(([key, value]) => JSON.stringify(left[key]) === JSON.stringify(value))
}

/** This runs synchronously before hashing, device persistence, outbox leadership or engine startup can yield. */
export const beginAdmission = (flow: string, payload: Readonly<Record<string, unknown>>, identity?: WriteIntent["identity"], draftId?: string, composer?: WriteIntent["composer"]) => Effect.gen(function* () {
  const store = yield* Effect.serviceOption(WriteIntents)
  const held = Option.isNone(store) ? undefined : store.value.pending().find(row => row.flow === flow && row.cleaned !== true &&
    (draftId !== undefined ? row.draftId === draftId : composer !== undefined && row.composer?.conversationId === composer.conversationId && row.composer.text === composer.text && row.composer.generation === composer.generation) && samePayload(row.payload, payload))
  const intent: WriteIntent = held ?? { commandId: crypto.randomUUID(), flow, payload, ...(identity === undefined ? {} : { identity }), ...(draftId === undefined ? {} : { draftId }), ...(composer === undefined ? {} : { composer }) }
  const retained = Option.isNone(store) || store.value.retain(intent)
  if (retained && Option.isSome(store)) store.value.admitting.set(intent.commandId, (store.value.admitting.get(intent.commandId) ?? 0) + 1)
  yield* recordAdmission(intent.commandId, flow, "input", retained ? "retained" : "refused", yield* Clock.currentTimeMillis)
  return retained ? Option.some(intent) : Option.none<WriteIntent>()
})

export const executionOf = (intent: WriteIntent) => (intent.identity === undefined
  ? Effect.succeed(intent.commandId)
  : Uuid.v5(intent.identity.namespace, intent.identity.value).pipe(Effect.provide(WebCrypto.layer), Effect.orDie)).pipe(
    Effect.tap(executionId => Effect.logInfo("write.identity").pipe(Effect.annotateLogs({ commandId: intent.commandId, executionId }))),
  )

export const identifyAdmission = (intent: WriteIntent, executionId: string, writeId: string) => Effect.gen(function* () {
  const store = yield* Effect.serviceOption(WriteIntents)
  if (Option.isSome(store)) {
    store.value.byWrite.set(writeId, intent.commandId)
    store.value.update(intent.commandId, { executionId, writeId })
  }
  yield* Effect.logInfo("write.identity").pipe(Effect.annotateLogs({ commandId: intent.commandId, executionId, writeId }))
})

const release = (store: WriteIntents["Service"], key: string) => {
  const remaining = (store.admitting.get(key) ?? 1) - 1
  if (remaining === 0) store.admitting.delete(key)
  else store.admitting.set(key, remaining)
}
const settle = (store: WriteIntents["Service"], intent: WriteIntent, admitted: boolean, cleaned: boolean) => {
  const previous = store.pending().find(row => row.commandId === intent.commandId)
  store.update(intent.commandId, { admitted: admitted || previous?.admitted === true, cleaned: (admitted && cleaned) || previous?.cleaned === true })
  const latest = store.pending().find(row => row.commandId === intent.commandId)
  if (latest?.admitted && latest.cleaned && (latest.flow !== "issue/create" || latest.navigated)) store.forget(intent.commandId)
}

export const finishAdmission = (intent: WriteIntent, admitted: boolean, cleaned = true) => Effect.gen(function* () {
  const store = yield* Effect.serviceOption(WriteIntents)
  if (Option.isSome(store)) {
    release(store.value, intent.commandId)
    settle(store.value, intent, admitted, cleaned)
  }
  yield* recordAdmission(intent.commandId, intent.flow, "outbox", admitted ? "admitted" : "not_admitted", yield* Clock.currentTimeMillis)
})

/** Explicit Retry completes the same input lifecycle without releasing another caller's admission fence. */
export const finishRetainedAdmission = (writeId: string, admitted: boolean, cleaned: boolean) => Effect.gen(function* () {
  const store = yield* Effect.serviceOption(WriteIntents)
  if (Option.isNone(store)) return
  const intent = store.value.pending().find(row => row.writeId === writeId || store.value.byWrite.get(writeId) === row.commandId)
  if (intent === undefined) return
  settle(store.value, intent, admitted, cleaned)
  yield* recordAdmission(intent.commandId, intent.flow, "outbox", admitted ? "admitted" : "not_admitted", yield* Clock.currentTimeMillis)
})

/** Includes legacy recovery rows that have no input snapshot. Finalization also releases cancellation/failure. */
export const whileAdmitting = <A, E, R>(writeId: string, effect: Effect.Effect<A, E, R>) => Effect.gen(function* () {
  const store = yield* Effect.serviceOption(WriteIntents)
  if (Option.isNone(store)) return yield* effect
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => store.value.admitting.set(writeId, (store.value.admitting.get(writeId) ?? 0) + 1)),
    () => effect,
    () => Effect.sync(() => release(store.value, writeId)),
  )
})

/** Navigation and delivery are independent receipts; neither may retire the other. */
export const acknowledgeNavigation = (writeId: string) => Effect.gen(function* () {
  const store = yield* Effect.serviceOption(WriteIntents)
  if (Option.isNone(store)) return
  const intent = store.value.pending().find(row => row.writeId === writeId || store.value.byWrite.get(writeId) === row.commandId)
  if (intent === undefined) return
  store.value.update(intent.commandId, { navigated: true })
  if (intent.admitted && intent.cleaned) store.value.forget(intent.commandId)
})

/** Synchronous lookup keeps Edit/Discard inside their existing synchronous frontend boundary. */
export const forgetAdmission = (_namespace: string, writeId: string) => Effect.gen(function* () {
  const store = yield* Effect.serviceOption(WriteIntents)
  if (Option.isNone(store)) return true
  if (store.value.admitting.has(writeId)) return false
  for (const intent of store.value.pending()) {
    if (intent.writeId !== writeId && store.value.byWrite.get(writeId) !== intent.commandId) continue
    if (store.value.admitting.has(intent.commandId) || !store.value.forget(intent.commandId)) return false
  }
  return true
})

/** A source draft cannot cancel admission while that admission is still running. */
export const forgetDraftAdmissions = (draftId: string) => Effect.gen(function* () {
  const store = yield* Effect.serviceOption(WriteIntents)
  if (Option.isNone(store)) return true
  const intents = store.value.pending().filter(row => row.draftId === draftId)
  if (intents.some(intent => store.value.admitting.has(intent.commandId) || (intent.writeId !== undefined && store.value.admitting.has(intent.writeId)) || [...store.value.byWrite].some(([id, command]) => command === intent.commandId && store.value.admitting.has(id)))) return false
  return intents.every(intent => store.value.forget(intent.commandId))
})

/** Start plus receipt records identify an interrupted or unresolved storage/engine boundary. */
export const admissionReceipt = <A, E, R>(effect: Effect.Effect<A, E, R>, commandId: string, flow: string, stage: string) => Effect.gen(function* () {
  const startedAt = yield* Clock.currentTimeMillis
  yield* recordAdmission(commandId, flow, stage, "pending", startedAt)
  return yield* effect.pipe(Effect.annotateLogs({ commandId, flow, stage }), Effect.onExit(exit => recordAdmission(commandId, flow, stage,
    Exit.isSuccess(exit) ? "confirmed" : Cause.hasInterruptsOnly(exit.cause) ? "interrupted" : "failed", startedAt)))
})
