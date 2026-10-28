import type { PendingSnapshot } from "@smthrs/platform-browser"
import { Uuid, WebCrypto } from "@smthrs/crypto"
import { Cause, Clock, Context, Effect, Exit, Layer, Metric, Option, PubSub, Schema, Stream } from "effect"

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
  /** When the press staged it (epoch ms); where its Requested toast sorts. */
  stagedAt: Schema.optional(Schema.Number),
  /** The door an engine operation's run is started through again on reload or Retry. */
  door: Schema.optional(Schema.Literals(["slash", "button"])),
  admitted: Schema.optional(Schema.Boolean),
  cleaned: Schema.optional(Schema.Boolean),
  navigated: Schema.optional(Schema.Boolean),
})
export type WriteIntent = typeof WriteIntent.Type
const decode = Schema.decodeUnknownOption(Schema.Array(WriteIntent))

/**
 * The operations whose admission is this device's engine recording their run (decision 0124). Their input bridges until
 * that run settled, not only until admission: a reload meanwhile starts the same execution again, so this tab answers
 * its run's calls once more, and a second press joins it; the run's own result admits and retires it (`settledEngineInputs`).
 * A tab whose session storage can't keep inputs keeps theirs in memory, for as long as the tab lives.
 */
export const ENGINE_OPERATIONS: ReadonlySet<string> = new Set(["conversation/new", "todo/issue"])

export class WriteIntents extends Context.Service<WriteIntents, {
  readonly pending: () => ReadonlyArray<WriteIntent>
  readonly retain: (intent: WriteIntent) => boolean
  readonly forget: (commandId: string) => boolean
  readonly update: (commandId: string, fields: Partial<WriteIntent>) => boolean
  readonly resumed: Map<string, string>
  readonly byWrite: Map<string, string>
  /** Admissions running in this tab, by command id (or a recovery row's write id). */
  readonly admitting: Map<string, number>
  /** When this tab's latest admission of a command was refused (epoch ms), by command id: the outbox or the engine said no. */
  readonly refused: Map<string, number>
  /**
   * The engine's own answers to this tab's dispatches of engine operations, by execution id: how the run ended, when this
   * tab heard, and what the toast names (decision 0124). This tab's only, for as long as it lives.
   */
  readonly answered: Map<string, Answered>
  /** Once after every change to the receipts, the admissions running or the refusals: what a projection reads again on. */
  readonly changes: Stream.Stream<void>
}>()("@smthrs/mvp/WriteIntents") {
  static readonly layer = (snapshot?: PendingSnapshot.Service, writable = true) => Layer.effect(WriteIntents, Effect.gen(function* () {
    const changed = yield* PubSub.unbounded<void>()
    const notify = () => void PubSub.publishUnsafe(changed, undefined)
    /** A map that says when it changed. */
    class Observed<V> extends Map<string, V> {
      override set(key: string, value: V) { super.set(key, value); notify(); return this }
      override delete(key: string) { const had = super.delete(key); if (had) notify(); return had }
    }
    const refused = new Observed<number>()
    // Engine operations' inputs a tab couldn't stage in its session storage: this tab's only.
    const memory = new Map<string, WriteIntent>()
    const staged = () => Option.getOrElse(decode(snapshot?.read()?.value), () => [])
    // A command's copy in memory is newer than the one storage last kept.
    const pending = () => [...staged().filter(row => !memory.has(row.commandId)), ...memory.values()]
    const retain = (intent: WriteIntent) => {
      const kept = writable && (snapshot === undefined || snapshot.stage([...staged().filter(row => row.commandId !== intent.commandId), intent]) !== undefined)
      if (kept) memory.delete(intent.commandId)
      else if (ENGINE_OPERATIONS.has(intent.flow)) memory.set(intent.commandId, intent)
      const held = kept || memory.has(intent.commandId)
      if (held) notify()
      return held
    }
    return {
      pending,
      retain,
      update: (commandId, fields) => {
        const intent = pending().find(row => row.commandId === commandId)
        return intent === undefined || retain({ ...intent, ...fields })
      },
      forget: commandId => {
        const had = pending().some(row => row.commandId === commandId)
        memory.delete(commandId)
        const held = snapshot?.read()
        if (held !== undefined) {
          const remaining = staged().filter(row => row.commandId !== commandId)
          if (remaining.length === 0) snapshot?.acknowledge(held.token)
          else snapshot?.stage(remaining)
        }
        const gone = !pending().some(row => row.commandId === commandId)
        if (gone) refused.delete(commandId)
        // Only a change is news: a forget storage refused changed nothing, and wakes nothing.
        if (had && gone) notify()
        return gone
      },
      resumed: new Map<string, string>(),
      byWrite: new Map<string, string>(),
      admitting: new Observed<number>(),
      refused,
      answered: new Observed<Answered>(),
      changes: Stream.fromPubSub(changed),
    }
  }))
}

/** How an engine operation's run ended, as the engine answered this tab's dispatch. */
export interface Answered {
  readonly flow: string
  readonly repo?: string | undefined
  readonly state: "done" | "failed"
  readonly at: number
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
export const beginAdmission = (flow: string, payload: Readonly<Record<string, unknown>>, identity?: WriteIntent["identity"], draftId?: string, composer?: WriteIntent["composer"], door?: WriteIntent["door"]) => Effect.gen(function* () {
  const store = yield* Effect.serviceOption(WriteIntents)
  // An engine operation's input lives until its run settled: a press while it runs joins it.
  const held = Option.isNone(store) ? undefined : store.value.pending().find(row => row.flow === flow && (row.cleaned !== true || ENGINE_OPERATIONS.has(row.flow)) &&
    (draftId !== undefined ? row.draftId === draftId : composer !== undefined && row.composer?.conversationId === composer.conversationId && row.composer.text === composer.text && row.composer.generation === composer.generation) && samePayload(row.payload, payload))
  const intent: WriteIntent = held ?? { commandId: crypto.randomUUID(), flow, payload, stagedAt: yield* Clock.currentTimeMillis, ...(identity === undefined ? {} : { identity }), ...(draftId === undefined ? {} : { draftId }), ...(composer === undefined ? {} : { composer }), ...(door === undefined ? {} : { door }) }
  const retained = Option.isNone(store) || store.value.retain(intent)
  if (retained && Option.isSome(store)) beginAttempt(store.value, intent.commandId, intent.commandId)
  yield* recordAdmission(intent.commandId, flow, "input", retained ? "retained" : "refused", yield* Clock.currentTimeMillis)
  return retained ? Option.some(intent) : Option.none<WriteIntent>()
})

export const executionOf = (intent: WriteIntent) => (intent.identity === undefined
  ? Effect.succeed(intent.commandId)
  : Uuid.v5(intent.identity.namespace, intent.identity.value).pipe(Effect.provide(WebCrypto.layer), Effect.orDie)).pipe(
    Effect.tap(executionId => Effect.logInfo("write.identity").pipe(Effect.annotateLogs({ commandId: intent.commandId, executionId }))),
  )

/** Correlates a command with its execution and, for an outbox write, its write id. An engine operation has none. */
export const identifyAdmission = (intent: WriteIntent, executionId: string, writeId?: string) => Effect.gen(function* () {
  const store = yield* Effect.serviceOption(WriteIntents)
  if (Option.isSome(store)) {
    if (writeId !== undefined) store.value.byWrite.set(writeId, intent.commandId)
    store.value.update(intent.commandId, writeId === undefined ? { executionId } : { executionId, writeId })
  }
  yield* Effect.logInfo("write.identity").pipe(Effect.annotateLogs({ commandId: intent.commandId, executionId, ...(writeId === undefined ? {} : { writeId }) }))
})

/**
 * Starts an admission of `commandId`, fenced under `key` (the command, or a recovery row's write id): the previous
 * attempt's refusal no longer speaks for it (decision 0124).
 */
export const beginAttempt = (store: WriteIntents["Service"], commandId: string, key: string) => {
  store.refused.delete(commandId)
  store.admitting.set(key, (store.admitting.get(key) ?? 0) + 1)
}

/** Whether an admission of `intent`'s command is running in this tab, under either key, beyond `own` of its own. */
const othersRunning = (store: WriteIntents["Service"], intent: WriteIntent, own: { readonly key: string; readonly count: number }) => {
  const held = (key: string) => (store.admitting.get(key) ?? 0) - (key === own.key ? own.count : 0)
  return held(intent.commandId) > 0 || (intent.writeId !== undefined && held(intent.writeId) > 0)
}

const release = (store: WriteIntents["Service"], key: string) => {
  const remaining = (store.admitting.get(key) ?? 1) - 1
  if (remaining === 0) store.admitting.delete(key)
  else store.admitting.set(key, remaining)
}
const settle = (store: WriteIntents["Service"], intent: WriteIntent, admitted: boolean, cleaned: boolean) => {
  const previous = store.pending().find(row => row.commandId === intent.commandId)
  store.update(intent.commandId, { admitted: admitted || previous?.admitted === true, cleaned: (admitted && cleaned) || previous?.cleaned === true })
  const latest = store.pending().find(row => row.commandId === intent.commandId)
  if (latest?.admitted && latest.cleaned && !ENGINE_OPERATIONS.has(latest.flow) && (latest.flow !== "issue/create" || latest.draftId === undefined || latest.navigated)) store.forget(intent.commandId)
}

/**
 * The engine operations' inputs whose run settled (`results`, by `run:<execution id>`), with how, that no attempt of
 * this tab is admitting.
 */
export const settledEngineInputs = (store: WriteIntents["Service"], results: ReadonlyMap<string, "done" | "failed">) =>
  store.pending().flatMap((intent) => {
    const state = ENGINE_OPERATIONS.has(intent.flow) ? results.get(`run:${intent.executionId}`) : undefined
    return state === undefined || store.admitting.has(intent.commandId) ? [] : [{ intent, state }]
  })

/**
 * How an admission ended, as this tab's projection reads it: admitted, refused (the outbox or the engine said no, at
 * `at`), or unconfirmed (its reply never came, which proves nothing either way). A refusal speaks for the command only
 * while no other attempt of it runs: a later attempt decides. Recorded in the same step as the fence's release, so the
 * toast goes from Requested straight to Failed.
 */
const outcomeOf = (
  store: WriteIntents["Service"],
  intent: WriteIntent,
  outcome: "admitted" | "refused" | "unconfirmed",
  at: number,
  own: { readonly key: string; readonly count: number },
) => {
  const latest = store.pending().find(row => row.commandId === intent.commandId) ?? intent
  if (outcome === "refused" && !othersRunning(store, latest, own)) store.refused.set(intent.commandId, at)
  else if (outcome === "admitted") store.refused.delete(intent.commandId)
}

export const finishAdmission = (intent: WriteIntent, admitted: boolean, cleaned = true, unconfirmed = false) => Effect.gen(function* () {
  const store = yield* Effect.serviceOption(WriteIntents)
  const at = yield* Clock.currentTimeMillis
  const outcome = admitted ? "admitted" : unconfirmed ? "unconfirmed" : "refused"
  if (Option.isSome(store)) {
    outcomeOf(store.value, intent, outcome, at, { key: intent.commandId, count: 1 })
    release(store.value, intent.commandId)
    settle(store.value, intent, admitted, cleaned)
  }
  yield* recordAdmission(intent.commandId, intent.flow, "outbox", admitted ? "admitted" : unconfirmed ? "unconfirmed" : "not_admitted", at)
})

/** Explicit Retry completes the same input lifecycle without releasing another caller's admission fence. */
export const finishRetainedAdmission = (writeId: string, admitted: boolean, cleaned: boolean) => Effect.gen(function* () {
  const store = yield* Effect.serviceOption(WriteIntents)
  if (Option.isNone(store)) return
  const intent = store.value.pending().find(row => row.writeId === writeId || store.value.byWrite.get(writeId) === row.commandId)
  if (intent === undefined) return
  const at = yield* Clock.currentTimeMillis
  // Called inside its own `whileAdmitting(writeId)`, whose fence is still held.
  outcomeOf(store.value, intent, admitted ? "admitted" : "refused", at, { key: writeId, count: 1 })
  settle(store.value, intent, admitted, cleaned)
  yield* recordAdmission(intent.commandId, intent.flow, "outbox", admitted ? "admitted" : "not_admitted", at)
})

/** Includes legacy recovery rows that have no input snapshot. Finalization also releases cancellation/failure. */
export const whileAdmitting = <A, E, R>(writeId: string, effect: Effect.Effect<A, E, R>) => Effect.gen(function* () {
  const store = yield* Effect.serviceOption(WriteIntents)
  if (Option.isNone(store)) return yield* effect
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => {
      const intent = store.value.pending().find(row => row.writeId === writeId || store.value.byWrite.get(writeId) === row.commandId)
      if (intent === undefined) store.value.admitting.set(writeId, (store.value.admitting.get(writeId) ?? 0) + 1)
      else beginAttempt(store.value, intent.commandId, writeId)
    }),
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
