import { CHAT_REFUSALS, type ChatCommand } from "@smthrs/app-state"
import { ShardProtocol } from "@smthrs/sync"
import { Context, type Duration, Effect, Layer, Metric, Option, Schema } from "effect"
import * as MessagesShard from "./MessagesShard.ts"
import * as MessagesShardRoutes from "./MessagesShardRoutes.ts"

// ChatApi's own writes, sequenced into the conversation's messages shard as well (decision 0170, slice 4c). Postgres
// and Electric still serve the conversation every page shows; each question ChatApi stores and each answer it records
// is also submitted to the shard, so the shard holds the same transcript when reads move to it (slice 5).
//
// The bridge never fails and never changes what Postgres did: a write the shard did not take is a log line and a count,
// and the request that made it goes on. Every command has a key derived from what it writes, so the same request sent
// again, or the same answer given again, is answered from the key's receipt and adds nothing.
//
// Who asked stays on the server (worker/Chat.ts `SYNCED_MESSAGE_COLUMNS`, decision 0013): a shard's authors and keys
// reach every reader of the conversation on Pull and Snapshot, so the bridge is never told who asked. It writes each
// message under an owner name made of that message's own id, which every reader already holds, and nothing else.

/** A question ChatApi stored, with the pending answer it stored beside it (worker/Messages.ts `ask`). */
export interface Asked {
  readonly conversationId: string
  readonly questionId: string
  readonly answerId: string
  readonly text: string
}

/** An answer ChatApi recorded whole and finished (worker/attach/LiveMount.ts `conversation_respond`). */
export interface Answered {
  readonly conversationId: string
  readonly questionId: string
  readonly answerId: string
  readonly text: string
}

/** What became of one bridged write: every command sequenced (`ok`), or the first that was not, by why. */
export type Outcome = "ok" | "refused" | "idempotency_conflict" | "stale_epoch" | "unavailable" | "timeout"

/** Bridged writes, by `write` (`asked`, `answered`) and `outcome`. */
export const writes = Metric.counter("smithers_messages_shard_bridge_writes", {
  description: "ChatApi writes bridged into a conversation's messages shard, by write and outcome",
  incremental: true,
})

/** The device every bridged command is submitted from, under its author's owner name. */
export const BRIDGE_DEVICE = "chatapi"

/** The owner names the bridge writes under, which the shard admits its ids to (MessagesShard.ts `BRIDGE_ID`). */
export const questionOwner = MessagesShard.questionOwner
export const answerOwner = MessagesShard.answerOwner

const isUuid = Schema.is(Schema.String.check(Schema.isUUID()))

const REDUCER_REFUSALS: ReadonlySet<string> = new Set(CHAT_REFUSALS)
const SHARD_REFUSALS: ReadonlySet<string> = new Set(MessagesShard.REFUSAL_REASONS)
/** A code as a log line carries it: itself when it is one of `known`, `other` for any other text an answer held. */
const coded = (known: ReadonlySet<string>, code: string): string => (known.has(code) ? code : "other")

type Step = { readonly writer: MessagesShard.Writer; readonly id: string; readonly payload: ChatCommand }

/** The answer's post and its first status, as `asked` and `answered` both submit them: one key each, whoever is first. */
const pendingAnswer = (answer: { readonly questionId: string; readonly answerId: string }) => {
  const author = answerOwner(answer.answerId)
  const writer = { author }
  const steps: ReadonlyArray<Step> = [
    {
      writer,
      id: `answer:${answer.answerId}`,
      payload: {
        _tag: "PostMessage",
        messageId: answer.answerId,
        author,
        body: "",
        role: "assistant",
        questionId: answer.questionId,
      },
    },
    {
      writer,
      id: `streaming:${answer.answerId}`,
      payload: { _tag: "UpdateMessageStatus", messageId: answer.answerId, status: "streaming" },
    },
  ]
  return { writer, steps }
}

const askedSteps = (asked: Asked): ReadonlyArray<Step> => {
  const author = questionOwner(asked.questionId)
  return [
    {
      writer: { author },
      id: `question:${asked.questionId}`,
      payload: { _tag: "PostMessage", messageId: asked.questionId, author, body: asked.text, role: "user" },
    },
    ...pendingAnswer(asked).steps,
  ]
}

const answeredSteps = (answered: Answered): ReadonlyArray<Step> => {
  const { writer, steps } = pendingAnswer(answered)
  return [
    // The answer's own post first, under the key `asked` used: a duplicate when the question was bridged, and the
    // answer's first appearance when it was asked before the bridge or its bridge failed.
    ...steps,
    {
      writer,
      // The body only grows, so its length names which body this is.
      id: `body:${answered.answerId}:${answered.text.length}`,
      payload: { _tag: "UpdateMessageBody", messageId: answered.answerId, author: writer.author, body: answered.text },
    },
    {
      writer,
      id: `complete:${answered.answerId}`,
      payload: { _tag: "UpdateMessageStatus", messageId: answered.answerId, status: "complete" },
    },
  ]
}

export interface BridgeOptions {
  /** How long one bridged write may take, every command included, before the request goes on without it. Default 5 seconds. */
  readonly within?: Duration.Input
}

/**
 * ChatApi's writes into the messages shards. Absent from a deployment, or a test, with no shard binding: `asked` and
 * `answered` below then do nothing.
 */
export class MessagesShardBridge extends Context.Service<
  MessagesShardBridge,
  {
    readonly asked: (asked: Asked) => Effect.Effect<Outcome>
    readonly answered: (answered: Answered) => Effect.Effect<Outcome>
  }
>()("@smthrs/mvp/chat/MessagesShardBridge") {
  /** The bridge over `forward`, the way the Worker reaches a conversation's object. */
  static readonly make = <E>(forward: MessagesShardRoutes.Forward<E>, options: BridgeOptions = {}) => {
    /** Submits one command under the shard's epoch: the one named by a `StaleEpoch` answer, once. */
    const submit = (shard: ShardProtocol.ShardId, step: Step, epoch: number): Effect.Effect<
      ShardProtocol.SubmitResponse,
      MessagesShardRoutes.SubmitFailed
    > =>
      MessagesShardRoutes.submitAs(forward, step.writer, {
        version: ShardProtocol.protocolVersion,
        shard,
        epoch,
        command: {
          key: [`${step.writer.author}/${BRIDGE_DEVICE}`, step.id],
          stream: Schema.decodeUnknownSync(ShardProtocol.StreamId)(shard),
          payload: step.payload,
        },
      })
    /** Each command in order, stopping at the first the shard did not sequence: a later one assumes the earlier. */
    const sequence = (conversationId: string, steps: ReadonlyArray<Step>) =>
      Effect.gen(function*() {
        const shard = MessagesShard.shardOf(conversationId)
        let epoch = 0
        for (const step of steps) {
          let answer = yield* submit(shard, step, epoch)
          if (answer._tag === "StaleEpoch") {
            epoch = answer.epoch
            answer = yield* submit(shard, step, epoch)
          }
          if (answer._tag === "StaleEpoch") return { outcome: "stale_epoch", step: step.payload._tag } as const
          if (answer._tag === "IdempotencyConflict") {
            return { outcome: "idempotency_conflict", step: step.payload._tag } as const
          }
          if (answer._tag === "Refused") {
            return { outcome: "refused", step: step.payload._tag, reason: coded(REDUCER_REFUSALS, answer.reason) } as const
          }
        }
        return { outcome: "ok" } as const
      })
    const bridge = (
      write: "asked" | "answered",
      conversationId: string,
      ids: ReadonlyArray<string>,
      steps: () => ReadonlyArray<Step>,
    ): Effect.Effect<Outcome> =>
      Effect.gen(function*() {
        // Ids ChatApi's routes already hold to UUIDs; a shard is named, and a key built, from nothing else.
        const named = isUuid(conversationId)
        const result = named && ids.every((id) => isUuid(id))
          ? yield* sequence(conversationId, steps()).pipe(
            Effect.catch((failed) =>
              Effect.succeed({
                outcome: "unavailable",
                reason: failed.reason,
                ...(failed.status === undefined ? {} : { status: failed.status }),
                ...(failed.refusal === undefined ? {} : { refusal: coded(SHARD_REFUSALS, failed.refusal) }),
              } as const)
            ),
            Effect.timeoutOrElse({
              duration: options.within ?? "5 seconds",
              orElse: () => Effect.succeed({ outcome: "timeout" } as const),
            }),
          )
          : ({ outcome: "unavailable", reason: "invalid_target" } as const)
        yield* Metric.update(Metric.withAttributes(writes, { write, outcome: result.outcome }), 1)
        // What was written, by id and outcome only: never a question's or an answer's text, nor who asked. Every
        // field is a fixed code, a status or a UUID: a reason or a refusal outside its list is `other`, and a
        // conversation id that is not a UUID is left out, so no text an answer or a caller held reaches a log line.
        if (result.outcome !== "ok") {
          yield* Effect.logWarning("chat.shard.bridge").pipe(
            Effect.annotateLogs({ write, ...(named ? { conversationId: conversationId.toLowerCase() } : {}), ...result }),
          )
        }
        return result.outcome
      }).pipe(Effect.withSpan("chat.shard.bridge", { attributes: { write } }))
    // A UUID has equivalent case spellings; a message id and a key have one, as Postgres prints it.
    const lower = <A extends Asked | Answered>(write: A): A => ({
      ...write,
      conversationId: write.conversationId.toLowerCase(),
      questionId: write.questionId.toLowerCase(),
      answerId: write.answerId.toLowerCase(),
    })
    return MessagesShardBridge.of({
      asked: (asked) =>
        bridge("asked", asked.conversationId, [asked.questionId, asked.answerId], () => askedSteps(lower(asked))),
      answered: (answered) =>
        bridge("answered", answered.conversationId, [answered.questionId, answered.answerId], () =>
          answeredSteps(lower(answered))),
    })
  }

  static readonly layer = <E>(forward: MessagesShardRoutes.Forward<E>, options: BridgeOptions = {}) =>
    Layer.succeed(MessagesShardBridge, MessagesShardBridge.make(forward, options))
}

/** Bridges a stored question and its pending answer, where a bridge is provided. Never fails. */
export const asked = (question: Asked): Effect.Effect<void> =>
  Effect.flatMap(Effect.serviceOption(MessagesShardBridge), (bridge) =>
    Option.isNone(bridge) ? Effect.void : Effect.asVoid(bridge.value.asked(question)))

/** Bridges a recorded answer and its completion, where a bridge is provided. Never fails. */
export const answered = (answer: Answered): Effect.Effect<void> =>
  Effect.flatMap(Effect.serviceOption(MessagesShardBridge), (bridge) =>
    Option.isNone(bridge) ? Effect.void : Effect.asVoid(bridge.value.answered(answer)))
