/**
 * telegram-inbox: receive a Telegram bot's messages and record each one in a
 * memory thread, once.
 *
 *   receive: poll getUpdates (maxTurns turns)
 *     -> per message: start telegram-inbox/message (execution id from the update) -> record in the thread
 *     -> commit the offset once the whole batch is recorded
 *
 * The bot token is `SMITHERS_TELEGRAM_BOT_TOKEN`. The offset lives in the
 * integrations cursor table of the engine database, so a restarted run polls
 * on from where the last one committed and a batch polled twice records each
 * message once. A run is bounded by `maxTurns`; a durable trigger with
 * `--overlap skip` keeps exactly one poller going:
 *
 *   smthrs triggers register --flow telegram-inbox --cron "* * * * *" --overlap skip \
 *     --data '{"allowedChatIds":["<chat id>"],"thread":"telegram/inbox"}'
 *
 * Read what arrived with `smthrs memory messages list telegram/inbox`.
 */
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
import { createHash } from "node:crypto"
import { Failure, fromIntegrationError } from "../../../packages/smithers/agent/integrations/src/core/ActionFailure.ts"
import { layerSql } from "../../../packages/smithers/agent/integrations/src/core/CursorStore.ts"
import { ExternalEvent } from "../../../packages/smithers/agent/integrations/src/core/ExternalEvent.ts"
import { IntegrationError } from "../../../packages/smithers/agent/integrations/src/core/IntegrationError.ts"
import * as Migrations from "../../../packages/smithers/agent/integrations/src/core/Migrations.ts"
import * as TelegramSource from "../../../packages/smithers/agent/integrations/src/telegram/Source.ts"
import * as MemoryStore from "../../../packages/smithers/agent/memory/src/MemoryStore.ts"

const implementationVersion = "telegram-inbox/v1"

/** What one polling run is asked to do. */
export const Request = Schema.Struct({
  /** Only messages from these chats are recorded. */
  allowedChatIds: Schema.NonEmptyArray(Schema.NonEmptyString),
  /** The memory thread messages are appended to. */
  thread: Schema.NonEmptyString,
  /** The thread's memory namespace when the run creates it. Defaults to `global:telegram`. */
  namespace: Schema.optionalKey(Schema.NonEmptyString),
  /** Poll turns per run. Defaults to 2, about 50 seconds with the default poll timeout. */
  maxTurns: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  /** How long Telegram holds each poll open, 0 to 50 seconds. Defaults to 25. */
  pollTimeoutSeconds: Schema.optionalKey(Schema.Int),
  /** The cursor key, so two bots keep separate offsets. Defaults to `telegram`. */
  sourceId: Schema.optionalKey(Schema.NonEmptyString),
  /** Another Bot API origin, for a shadow run against a fixture server. */
  apiBaseUrl: Schema.optionalKey(Schema.NonEmptyString)
})

/**
 * One received message on its way to the thread. It leaves out the receive
 * time, so the same update polled again starts the same message run.
 */
export const Delivery = Schema.Struct({
  thread: Schema.NonEmptyString,
  namespace: Schema.NonEmptyString,
  event: ExternalEvent.mapFields(({ receivedAtMs: _, ...fields }) => fields)
})

/** What the thread stores for a message: who sent it where, and its text. */
export const entry = (event: Pick<ExternalEvent, "eventName" | "payload">): string => {
  const message = event.payload as Record<string, any>
  return JSON.stringify({
    event: event.eventName,
    chatId: message["chat"]?.["id"] ?? null,
    fromId: message["from"]?.["id"] ?? null,
    messageId: message["message_id"] ?? null,
    date: message["date"] ?? null,
    text: message["text"] ?? message["caption"] ?? null
  })
}

const memoryFailure = (error: { readonly message: string }) =>
  fromIntegrationError(
    new IntegrationError("delivery-failed", `telegram-inbox could not record a message: ${error.message}`, {
      retryable: true
    })
  )

/** Appends one message to the thread; the update's dedupe key is its id, so a repeat is a no-op. */
export const Record = Action.make("telegram-inbox/record", {
  implementationVersion,
  payload: Delivery,
  success: Schema.Void,
  error: Failure
})

/** The flow each message starts. */
export const Message = Flow.make("telegram-inbox/message", {
  description: "Record one received Telegram message in a memory thread.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Delivery,
  success: Schema.Void,
  error: Failure,
  body: Node.capture({ implementationVersion }, (delivery) => Record.call(delivery))
})

/** The execution id of the message flow for `event`: the same update always maps to the same run. */
export const messageExecutionId = (event: Pick<ExternalEvent, "dedupeKey">): string =>
  `telegram-inbox/message/${createHash("sha256").update(event.dedupeKey).digest("hex")}`

// A message run that could not record holds the offset in place; only the record's own failure may clear on retry.
const messageFailure = (error: { readonly _tag: string }) =>
  new IntegrationError("delivery-failed", `telegram-inbox/message failed: ${error._tag}`, {
    retryable: "retryable" in error && error.retryable === true
  })

const withoutReceiptTime = ({ receivedAtMs: _, ...event }: ExternalEvent) => event

/** One polling run. */
export const Receive = Action.make("telegram-inbox/receive", {
  implementationVersion,
  payload: Request,
  success: Schema.Void,
  error: Failure,
  nondeterministic: true
})

const record = Record.toLayer((delivery) =>
  Effect.gen(function*() {
    const store = yield* MemoryStore.MemoryStore
    if ((yield* store.getThread({ threadId: delivery.thread })) === undefined) {
      yield* store.createThread({ id: delivery.thread, namespace: delivery.namespace, title: "Telegram inbox" })
    }
    yield* store.appendMessageOnce({
      threadId: delivery.thread,
      id: delivery.event.dedupeKey,
      role: "user",
      text: entry(delivery.event)
    })
  }).pipe(Effect.mapError(memoryFailure)), { implementationVersion })

// HTTP goes through the host's HttpClient, so the flow's `net:post` capability governs it.
const receive = Receive.toLayer((request) =>
  Effect.gen(function*() {
    const namespace = request.namespace ?? "global:telegram"
    const source = yield* TelegramSource.make({
      allowedChatIds: request.allowedChatIds,
      sourceId: request.sourceId,
      pollTimeoutSeconds: request.pollTimeoutSeconds,
      apiBaseUrl: request.apiBaseUrl
    })
    yield* source.run(
      (events) =>
        Effect.forEach(events, (event) =>
          Message.execute({ thread: request.thread, namespace, event: withoutReceiptTime(event) }, {
            executionId: messageExecutionId(event)
          }).pipe(Effect.mapError(messageFailure)), { discard: true }),
      { maxTurns: request.maxTurns ?? 2 }
    )
  }).pipe(Effect.mapError(fromIntegrationError)), { implementationVersion })

/**
 * The record and receive actions, the message flow (no file declares it), and
 * the cursor table in the host's engine database.
 */
export const layer = receive.pipe(
  // The receive action starts message runs, so it needs their interpreter and record action.
  Layer.provideMerge(Interpreter.layerWithImplementations(Message, record)),
  Layer.provideMerge(layerSql),
  Layer.provideMerge(Migrations.layer)
)

export default Flow.make("telegram-inbox", {
  description: "Poll a Telegram bot and record each message from an allowed chat in a memory thread, once.",
  capabilities: ["net:post:**"],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  modelInvocable: false,
  payload: Request,
  success: Schema.Void,
  error: Failure,
  body: Node.capture({ implementationVersion }, (request) => Receive.call(request))
})
