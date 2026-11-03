import { Collection, Outbox } from "@smthrs/effect-tanstack-db"
import { Context, Deferred, Effect, Layer, Metric, Option, Schema } from "effect"
import { type DispatchFailed, FlowDispatch } from "../../flows/dispatch"
import { ChatDraftsStore, ChatUnsentStore, outboxUpgrade } from "../../device/registry"
import { OutboxWrites } from "../../outbox"
import { FormValues } from "../views/schema"
import { ChatClient } from "./api"
import { answerCannotFinish } from "./answerEnd"
import { askFailures, writesReadyMs } from "./metrics"
import { Asking, Source, type Unsent, type UnsentReason } from "./schema"
import type { ChatHost } from "./store"

/** The Web Lock the tab leading the outbox holds. */
export const OUTBOX_LOCK = "smithers-outbox"

/**
 * What a refused send keeps the question as, by ChatApi's status: 400, 401 (signed out) and 403 (not a Member) are
 * `refused`, 409 `conflict`, 413 `too_large`. Any other failure is sent again.
 */
const refusal = (status: number | undefined): UnsentReason | undefined =>
  status === 400 || status === 401 || status === 403
    ? "refused"
    : status === 409
      ? "conflict"
      : status === 413
        ? "too_large"
        : undefined

/**
 * Keeps a question on the device as unsent, once: a send replayed after a crash finds it there. The row shows at once;
 * the Effect it returns waits until the device has stored it.
 */
export const keepUnsent = (unsent: Collection.Collection<Unsent, string>, row: Asking, reason: UnsentReason) =>
  Effect.gen(function* () {
    if (Option.isSome(yield* unsent.get(row.id))) return Effect.void
    const kept = yield* unsent.insert({
      id: row.id,
      answerId: row.answerId,
      text: row.text,
      queuedAt: row.queuedAt,
      reason,
      ...(row.conversationId === undefined ? {} : { conversationId: row.conversationId }),
      ...(row.source === undefined ? {} : { source: row.source }),
      ...(row.data === undefined ? {} : { data: row.data }),
    })
    return Effect.orDie(kept.persisted)
  }).pipe(Effect.orDie)

/** What a parked question's row must still say for Retry to ask it again: its ids, its text and when it was asked. */
const ParkedQuestion = Schema.Struct({
  id: Schema.String,
  answerId: Schema.String,
  text: Schema.String,
  queuedAt: Schema.Number,
  conversationId: Schema.optional(Schema.String),
  source: Schema.optional(Source),
  data: Schema.optional(FormValues),
})

/**
 * Shows a question the outbox parked as Not sent, with Retry and Discard (`not_admitted`): true once it is kept, false
 * when its row doesn't say enough to ask it again, so it stays parked.
 */
export const keepParked = (unsent: Collection.Collection<Unsent, string>, write: Outbox.Parked) =>
  Effect.gen(function* () {
    const row = Schema.decodeUnknownOption(ParkedQuestion)(write.rows[0])
    if (Option.isNone(row)) return false
    yield* Effect.flatten(keepUnsent(unsent, { ...row.value, v: 2 }, "not_admitted"))
    yield* Effect.logWarning("question parked").pipe(Effect.annotateLogs({ reason: write.reason, questionId: row.value.id }))
    return true
  })

// Local writes are available before any repository or conversation display store is evaluated. Only confirmation of
// a question the server took waits for chat's read side; initializing the outbox and saving a draft never do.
type Delivery = (row: Asking) => Effect.Effect<void, Outbox.Retry>

const make = (host: ChatHost) => Effect.gen(function* () {
  const started = performance.now()
  const scope = yield* Effect.scope
  const flows = yield* FlowDispatch
  const asking = yield* Collection.local<Asking, string>({ id: "chat-asking", schema: Asking, getKey: (row) => row.id })
  const unsent = yield* Collection.persisted(ChatUnsentStore)
  const drafts = yield* Collection.persisted(ChatDraftsStore)
  const delivery = yield* Deferred.make<Delivery>()
  // This device's agent answers the question ChatApi took: `chat/Answer`, with the answer's id as its execution id. It
  // waits until the engine has recorded the run, so the outbox keeps the question until a run exists to answer it; the
  // run goes on in the background. The engine starts an execution once, so a resend that dispatches it again starts no
  // second run. A start that fails (no engine in this tab, refused, the tab closing) is sent again; the dispatch has
  // logged and counted it. A run refused because the app changed under it (parked under one build, resumed under the
  // next: `plan_changed`, or `payload_changed` when its recorded payload no longer decodes), or confirmed cancelled,
  // cannot finish, so
  // `chat/Close` settles its answer failed, under its own execution id; a resend finds a run refused before, so it
  // closes answers left streaming by an earlier build too.
  const answer = (row: Asking) =>
    Effect.gen(function* () {
      const admitted = yield* Deferred.make<void, DispatchFailed>()
      yield* flows.dispatch("chat/Answer", { answerId: row.answerId }, {
        door: "composer",
        executionId: row.answerId,
        admitted,
      }).pipe(
        // expected: an answer that cannot finish is closed instead
        Effect.catchIf(
          answerCannotFinish,
          () => flows.dispatch("chat/Close", { answerId: row.answerId }, {
            door: "composer", executionId: `${row.answerId}/close`,
          }),
        ),
        Effect.ignore,
        Effect.forkIn(scope),
      )
      yield* Deferred.await(admitted).pipe(
        Effect.tapError(({ reason }) =>
          Effect.logWarning("answer not started").pipe(Effect.annotateLogs({ reason }))
        ),
        Effect.mapError(() => new Outbox.Retry({})),
      )
    })

  // Sends one queued question. A refusal (400, 401, 403, 409, 413) keeps it as unsent and stops; anything else is sent
  // again. It is done once ChatApi took it, this device's engine recorded the run that answers it, and Electric
  // delivered it.
  const send = ({ rows }: { readonly rows: ReadonlyArray<unknown> }) => {
    const row = rows[0] as Asking
    return Effect.gen(function* () {
      const client = yield* ChatClient
      const taken = yield* client.ask({
        id: row.id,
        answerId: row.answerId,
        text: row.text,
        ...(row.conversationId === undefined ? {} : { conversationId: row.conversationId }),
        ...(row.source === undefined ? {} : { source: row.source }),
        ...(row.data === undefined ? {} : { data: row.data }),
      }).pipe(
        Effect.catchTag("QuestionNotTaken", (error): Effect.Effect<never, Outbox.Retry | Outbox.Refused> => {
          const reason = refusal(error.status)
          return reason === undefined
            ? Effect.fail(new Outbox.Retry(error.status === undefined ? {} : { status: error.status }))
            : keepUnsent(unsent, row, reason).pipe(
                Effect.flatten,
                Effect.andThen(Metric.update(Metric.withAttributes(askFailures, { reason }), 1)),
                Effect.andThen(
                  Effect.logWarning("question not sent").pipe(Effect.annotateLogs({ reason, status: error.status })),
                ),
                Effect.andThen(Effect.fail(new Outbox.Refused({ status: error.status! }))),
              )
        }),
      )
      yield* Effect.annotateCurrentSpan({ taken: taken._tag })
      yield* answer(row)
      yield* Effect.flatMap(Deferred.await(delivery), (confirm) => confirm(row))
      yield* Effect.logInfo("question stored").pipe(Effect.annotateLogs({ taken: taken._tag }))
    }).pipe(
      Effect.annotateLogs({ feature: "chat", questionId: row.id, answerId: row.answerId }),
      Effect.withSpan("chat.ask.send", { attributes: { questionId: row.id, answerId: row.answerId } }),
    )
  }

  const leader = yield* Outbox.lockLeader({ lock: host.lock, name: OUTBOX_LOCK })
  // The device's one outbox: chat's questions, and the writes other features hand over (src/outbox.ts).
  const others = yield* OutboxWrites
  const outbox = Context.get(
    yield* Layer.build(
      Outbox.layer({
        ...host.outbox,
        leader,
        collections: { ...others.collections, asking },
        mutations: { ...others.mutations, ask: send },
        // Writes an older build stored are upgraded before the outbox loads them, or parked (decision 0021 §4): a
        // parked question shows Not sent, with Retry and Discard.
        upgrade: outboxUpgrade,
        parked: { ...others.parked, ask: (write) => keepParked(unsent, write) },
      }),
    ),
    Outbox.Outbox,
  )

  const restored = yield* Effect.result(drafts.restored)
  const durationMs = performance.now() - started
  yield* Metric.update(writesReadyMs, durationMs)
  yield* Effect.logInfo("chat.writes.ready").pipe(Effect.annotateLogs({ feature: "chat", durationMs, drafts: restored._tag === "Success" ? "restored" : "failed" }))
  return {
    asking, unsent, drafts, outbox, leader,
    confirmWith: (confirm: Delivery) => Effect.asVoid(Deferred.succeed(delivery, confirm)),
  }
})

/** The device's drafts and outbox, independent of the data gate and all page queries. */
export class ChatWrites extends Context.Service<ChatWrites, Effect.Success<ReturnType<typeof make>>>()("@smthrs/mvp/chat/ChatWrites") {
  static readonly layer = (host: ChatHost) => Layer.effect(ChatWrites, make(host))
}
