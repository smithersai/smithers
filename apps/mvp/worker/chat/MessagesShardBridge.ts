import {
  CHAT_REFUSALS,
  type ChatCommand,
  MAX_BODY_LENGTH,
  type MessageFailure,
  type MessageNotes,
  type MessageRun,
  type MessageSource,
} from "@smthrs/app-state"
import { ShardProtocol } from "@smthrs/sync"
import { Context, type Duration, Effect, Layer, Metric, Option, Schema } from "effect"
import * as MessagesShard from "./MessagesShard.ts"
import * as MessagesShardRoutes from "./MessagesShardRoutes.ts"

// ChatApi's own writes, sequenced into the conversation's messages shard as well (decision 0170, slices 4c and 5a).
// Each question ChatApi stores, each answer it records and each note the timeline writes on a message is also submitted
// to the shard, with the place and the time Postgres gave it, so the shard holds the transcript a page reads when its
// reads move there (src/features/chat/messagesShardRows.ts).
//
// The bridge is told what Postgres holds after its transaction committed (worker/chat/MessagesShardSource.ts), never
// what a request asked for: a write Postgres rolled back is never one the shard holds, and the same write read again
// builds the same commands. It never fails and never changes what Postgres did: a write the shard did not take is a log
// line and a count, and the request that made it goes on. Every command has a key derived from what it writes, so the
// same request sent again, or the same answer given again, is answered from the key's receipt and adds nothing.
//
// Who asked stays on the server (worker/Chat.ts `SYNCED_MESSAGE_COLUMNS`, decision 0013): a shard's authors and keys
// reach every reader of the conversation on Pull and Snapshot, so the bridge is never told who asked. It writes each
// message under an owner name made of that message's own id, which every reader already holds, and nothing else.
//
// Order is Postgres's, not arrival's. Each post carries its row's `position`, and a page orders by it, so a question
// that reaches the shard after its answer still reads before it. `answered` posts the question too: a conversation
// asked before the bridge, or whose `asked` never arrived, gets both. `noted` posts the exchange its message belongs
// to first, for the same reason, as Postgres holds it: a question with no answer alone, a pair whose answer still
// streams, or an answer that ended with its text, what its run wrote and how it ended, finished or failed. A note that
// still reaches the shard before its message takes no receipt there (MessagesShard.ts `decide`, `missing`), so the same
// note sent again once the message is there is taken. A note carries the version Postgres counted for the row's notes,
// and the shard ignores one no newer than the one it holds (`@smthrs/app-state` `decideChat`), so a delayed older note
// never replaces a newer one.
//
// A note is settled by its own command and nothing else (`NoteResult`). What is posted before it only makes sure its
// message is there: a post or an update the shard decided against leaves the message as the shard holds it, and the
// note is still sent. Only the shard's answer to the note itself, sequenced or held already, says the shard has that
// version of the notes.

/** Where Postgres put a message, and when: its `position` and its `created_at` as Postgres prints it. */
export interface Placed {
  readonly position: number
  readonly createdAt: string
}

/** A stored question: its text, its place, and the view it was sent from with its values as JSON text, if any. */
export interface Question extends Placed {
  readonly text: string
  readonly source?: MessageSource
  readonly data?: string
}

/** A question Postgres holds with no answer beside it. */
export interface Lone {
  readonly conversationId: string
  readonly questionId: string
  readonly question: Question
}

/** A question ChatApi stored, with the pending answer it stored beside it (worker/Messages.ts `ask`). */
export interface Asked extends Lone {
  readonly answerId: string
  readonly answer: Placed
}

/**
 * An answer that ended, as Postgres holds it, and its question: recorded whole and finished
 * (worker/attach/LiveMount.ts `conversation_respond`), or failed, with why.
 */
export interface Answered extends Asked {
  /** The answer's text: all of it when it finished, what it had when it failed. */
  readonly text: string
  /** When Postgres last wrote the answer's row. */
  readonly updatedAt: string
  /** Why the answer failed. Absent on one that finished. */
  readonly failure?: MessageFailure
  /**
   * What the answer's run wrote, as Postgres holds it: the steps it took, its model, why it stopped and its token
   * counts. Written with the answer's last time, before the status that freezes them. Absent where Postgres holds none.
   */
  readonly run?: Omit<MessageRun, "failure">
}

/** What Postgres holds of an exchange: its question alone, the pair while the answer streams, or the ended answer. */
export type Exchange = Lone | Asked | Answered

/** Whether Postgres holds an answer beside the question. */
export const isAsked = (exchange: Exchange): exchange is Asked | Answered => "answerId" in exchange

/** Whether what Postgres holds of an exchange is its ended answer too. */
export const isAnswered = (exchange: Exchange): exchange is Answered => "text" in exchange

/**
 * What the timeline has written on one message (worker/TimelineSummaries.vibe), whole, as one row of Postgres holds
 * it: its summary, and the phase and the arc that start at it. A mark taken away, or never set, is `""`. `version` is
 * which write of the row's notes this is, counted by Postgres as it commits each (`messages.notes_version`): the same
 * version is the same notes, and a higher one is a later write. `exchange` is the question and answer the message
 * belongs to, as Postgres holds them.
 */
export interface Noted {
  readonly conversationId: string
  readonly messageId: string
  readonly role: "user" | "assistant"
  readonly version: number
  readonly notes: Pick<MessageNotes, "summary" | "summaryRevision" | "phase" | "arc">
  readonly exchange?: Exchange
}

/**
 * What became of one bridged write: every command sequenced (`ok`); every command sequenced except a post the shard
 * already held in another form, which stands (`kept`); or the first that was not, by why.
 */
export type Outcome = "ok" | "kept" | "refused" | "idempotency_conflict" | "stale_epoch" | "unavailable" | "timeout"

/**
 * What became of one bridged note. `outcome` is the write's, as every bridged write has one: the first command the
 * shard did not sequence, the note's own included. `settled` is the note's alone: whether the shard answered the
 * command that carries this version of the notes `Accepted` or `Duplicate`, so it holds that version or a later one.
 * A command posted before the note, refused or in conflict, never settles it, and neither does a note that was not
 * sent.
 */
export interface NoteResult {
  readonly outcome: Outcome
  readonly settled: boolean
}

/** Bridged writes, by `write` (`asked`, `answered`, `noted`) and `outcome`. */
export const writes = Metric.counter("smithers_messages_shard_bridge_writes", {
  description: "ChatApi writes bridged into a conversation's messages shard, by write and outcome",
  incremental: true,
})

/** The device every bridged command is submitted from, under its author's owner name. */
export const BRIDGE_DEVICE = MessagesShard.BRIDGE_DEVICE

/** The owner names the bridge writes under, which the shard admits its ids to (MessagesShard.ts `BRIDGE_ID`). */
export const questionOwner = MessagesShard.questionOwner
export const answerOwner = MessagesShard.answerOwner

const isUuid = Schema.is(Schema.String.check(Schema.isUUID()))

const REDUCER_REFUSALS: ReadonlySet<string> = new Set(CHAT_REFUSALS)
const SHARD_REFUSALS: ReadonlySet<string> = new Set(MessagesShard.REFUSAL_REASONS)
/** A code as a log line carries it: itself when it is one of `known`, `other` for any other text an answer held. */
const coded = (known: ReadonlySet<string>, code: string): string => (known.has(code) ? code : "other")

type Step = { readonly writer: MessagesShard.Writer; readonly id: string; readonly payload: ChatCommand }

/** The question's post: one key, whoever writes it first. */
const questionStep = (lone: Lone): Step => {
  const asker = questionOwner(lone.questionId)
  const { text, position, createdAt, source, data } = lone.question
  return {
    writer: { author: asker },
    id: `question:${lone.questionId}`,
    payload: {
      _tag: "PostMessage",
      messageId: lone.questionId,
      author: asker,
      body: text,
      role: "user",
      position,
      createdAt,
      ...(source === undefined ? {} : { source }),
      ...(data === undefined ? {} : { data }),
    },
  }
}

/** The question's post, then the answer's post and its first status: one key each, whoever writes them first. */
const exchangeSteps = (asked: Asked): ReadonlyArray<Step> => {
  const author = answerOwner(asked.answerId)
  return [
    questionStep(asked),
    {
      writer: { author },
      id: `answer:${asked.answerId}`,
      payload: {
        _tag: "PostMessage",
        messageId: asked.answerId,
        author,
        body: "",
        role: "assistant",
        questionId: asked.questionId,
        position: asked.answer.position,
        createdAt: asked.answer.createdAt,
      },
    },
    {
      writer: { author },
      id: `streaming:${asked.answerId}`,
      payload: { _tag: "UpdateMessageStatus", messageId: asked.answerId, status: "streaming" },
    },
  ]
}

/**
 * The body a body update carries of `text`: all of it within the reducer's bound (`MAX_BODY_LENGTH`), and the longest
 * whole prefix within it of a text past the bound, which Postgres holds of an answer stored before the bound was. The
 * cut never parts a surrogate pair, so what is kept is whole Unicode text, which the reducer takes. An answer cut
 * here still ends: the status that follows its body is sent, where a body the shard refused left it streaming.
 */
export const bodyWithin = (text: string): string => {
  if (text.length <= MAX_BODY_LENGTH) return text
  const last = text.charCodeAt(MAX_BODY_LENGTH - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? MAX_BODY_LENGTH - 1 : MAX_BODY_LENGTH)
}

const encoder = new TextEncoder()

/**
 * The request `build` makes of `payload`, as it fits in `maxBytes` of JSON in UTF-8, the most the object reads of a
 * submit (MessagesShardRoutes.ts `MAX_SHARD_COMMAND_BYTES`): the whole command when it fits, and otherwise the command
 * without as many of its last steps as it takes, its first steps kept in order. A command the reducer takes always
 * fits, so nothing is shed of one. A command still too large with no steps left is sent as it is, and refused. An
 * answer whose run holds more than a submit carries still ends: the status that follows it is sent, where a run the
 * object refused left it streaming.
 */
export const fitted = <R>(payload: ChatCommand, build: (payload: ChatCommand) => R, maxBytes: number): R => {
  let fit = payload
  let request = build(fit)
  while (encoder.encode(JSON.stringify(request)).length > maxBytes) {
    if (!("parts" in fit) || fit.parts === undefined || fit.parts.length === 0) return request
    const { parts, ...rest } = fit
    const kept = parts.slice(0, -1)
    fit = kept.length === 0 ? rest : { ...rest, parts: kept }
    request = build(fit)
  }
  return request
}

const answeredSteps = (answered: Answered): ReadonlyArray<Step> => {
  const writer = { author: answerOwner(answered.answerId) }
  const body = bodyWithin(answered.text)
  return [
    // The exchange's own posts first, under the keys `asked` used: duplicates when the question was bridged, and the
    // question's and the answer's first appearance when it was asked before the bridge or its bridge failed.
    ...exchangeSteps(answered),
    {
      writer,
      // The body only grows, so its length names which body this is.
      id: `body:${answered.answerId}:${body.length}`,
      payload: { _tag: "UpdateMessageBody", messageId: answered.answerId, author: writer.author, body },
    },
    answered.failure === undefined
      ? {
        writer,
        // What its run wrote and its last time, before the status that freezes the run's: the time names which write
        // this is.
        id: `updated:${answered.answerId}:${answered.updatedAt}`,
        payload: { _tag: "UpdateMessageMetadata", messageId: answered.answerId, ...answered.run, updatedAt: answered.updatedAt },
      }
      : {
        writer,
        // Why it failed is written with what its run wrote and its last time, before the status that freezes them.
        id: `failure:${answered.answerId}:${answered.updatedAt}`,
        payload: {
          _tag: "UpdateMessageMetadata",
          messageId: answered.answerId,
          ...answered.run,
          updatedAt: answered.updatedAt,
          failure: answered.failure,
        },
      },
    answered.failure === undefined
      ? {
        writer,
        id: `complete:${answered.answerId}`,
        payload: { _tag: "UpdateMessageStatus", messageId: answered.answerId, status: "complete" },
      }
      : {
        writer,
        id: `failed:${answered.answerId}`,
        payload: { _tag: "UpdateMessageStatus", messageId: answered.answerId, status: "failed" },
      },
  ]
}

/** What Postgres holds of an exchange, as posts: the question alone, the pending pair, or the ended answer. */
const stepsOf = (exchange: Exchange): ReadonlyArray<Step> =>
  isAnswered(exchange) ? answeredSteps(exchange) : isAsked(exchange) ? exchangeSteps(exchange) : [questionStep(exchange)]

/** The note's own command: the only one whose answer settles it. */
const noteStep = (noted: Noted): Step => ({
  // A message's notes are written under the name its post was: only its own author patches it (MessagesShard.ts `decide`).
  writer: { author: noted.role === "user" ? questionOwner(noted.messageId) : answerOwner(noted.messageId) },
  // The version names which notes these are: the same row read again is the same command under the same key.
  id: `noted:${noted.messageId}:${noted.version}`,
  payload: { _tag: "UpdateMessageMetadata", messageId: noted.messageId, ...noted.notes, noteVersion: noted.version },
})

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
    readonly noted: (noted: Noted) => Effect.Effect<NoteResult>
  }
>()("@smthrs/mvp/chat/MessagesShardBridge") {
  /** The bridge over `forward`, the way the Worker reaches a conversation's object. */
  static readonly make = <E>(forward: MessagesShardRoutes.Forward<E>, options: BridgeOptions = {}) => {
    /** Submits one command under `epoch`, as it fits in what the object reads (`fitted`). */
    const submit = (shard: ShardProtocol.ShardId, step: Step, epoch: number): Effect.Effect<
      ShardProtocol.SubmitResponse,
      MessagesShardRoutes.SubmitFailed
    > =>
      MessagesShardRoutes.submitAs(forward, step.writer, fitted(step.payload, (payload) => ({
        version: ShardProtocol.protocolVersion,
        shard,
        epoch,
        command: {
          key: [`${step.writer.author}/${BRIDGE_DEVICE}`, step.id],
          stream: Schema.decodeUnknownSync(ShardProtocol.StreamId)(shard),
          payload,
        },
      }), MessagesShardRoutes.MAX_SHARD_COMMAND_BYTES))
    /**
     * Each command of `steps` in order, stopping at the first the shard did not sequence: a later one assumes the
     * earlier. A post whose key the shard holds for other content is not a stop. Only the bridge posts under its ids,
     * and under its keys (MessagesShard.ts `BRIDGE_ID`, `ownsOrigin`), so that content is the same message as an
     * earlier bridge wrote it, before a post carried its place: the message stands as it is, a post never changes
     * one, and what follows still applies to it.
     *
     * Then `note`, where there is one, whatever the shard decided of `steps`: they only bring the note's message, and
     * a message the shard holds in another form, or already ended, still takes its notes. A shard that could not be
     * reached, or whose epoch kept moving, is given nothing more. `settled` is the answer to `note` alone.
     */
    const sequence = (conversationId: string, steps: ReadonlyArray<Step>, note?: Step) =>
      Effect.gen(function*() {
        const shard = MessagesShard.shardOf(conversationId)
        let epoch = 0
        /** One command under the shard's epoch: the one a `StaleEpoch` answer names, once. */
        const send = (step: Step) =>
          Effect.gen(function*() {
            const answer = yield* submit(shard, step, epoch)
            if (answer._tag !== "StaleEpoch") return answer
            epoch = answer.epoch
            return yield* submit(shard, step, epoch)
          })
        const stale = (step: Step) => ({ outcome: "stale_epoch", step: step.payload._tag } as const)
        const conflict = (step: Step) => ({ outcome: "idempotency_conflict", step: step.payload._tag } as const)
        const refusal = (step: Step, reason: string) =>
          ({ outcome: "refused", step: step.payload._tag, reason: coded(REDUCER_REFUSALS, reason) } as const)
        let before: { readonly outcome: Outcome; readonly step?: string; readonly reason?: string } = { outcome: "ok" }
        for (const step of steps) {
          const answer = yield* send(step)
          if (answer._tag === "StaleEpoch") return { result: stale(step), settled: false }
          if (answer._tag === "IdempotencyConflict" && step.payload._tag === "PostMessage") {
            before = { outcome: "kept", step: "PostMessage" }
            continue
          }
          if (answer._tag === "IdempotencyConflict") {
            before = conflict(step)
            break
          }
          if (answer._tag === "Refused") {
            before = refusal(step, answer.reason)
            break
          }
        }
        if (note === undefined) return { result: before, settled: false }
        let answer = yield* send(note)
        // A receipt that says the note's message was missing was kept before the shard refused such a note without
        // one (MessagesShard.ts `decide`, `missing`), and answers this key for ever. Its message is there now, or the
        // shard refuses again and keeps nothing: the same note is sent under a key that receipt does not hold.
        if (answer._tag === "Refused" && answer.reason === "message_missing") {
          answer = yield* send({ ...note, id: `${note.id}:again` })
        }
        if (answer._tag === "Accepted" || answer._tag === "Duplicate") return { result: before, settled: true }
        return {
          result: answer._tag === "StaleEpoch"
            ? stale(note)
            : answer._tag === "IdempotencyConflict"
            ? conflict(note)
            : refusal(note, answer.reason),
          settled: false,
        }
      })
    const bridge = (
      write: "asked" | "answered" | "noted",
      conversationId: string,
      ids: ReadonlyArray<string | undefined>,
      steps: () => ReadonlyArray<Step>,
      note?: () => Step,
    ): Effect.Effect<NoteResult> =>
      Effect.gen(function*() {
        const named = isUuid(conversationId)
        const { result, settled } = named && ids.every((id) => id !== undefined)
          ? yield* sequence(conversationId, steps(), note?.()).pipe(
            Effect.catch((failed) =>
              Effect.succeed({
                result: {
                  outcome: "unavailable",
                  reason: failed.reason,
                  ...(failed.status === undefined ? {} : { status: failed.status }),
                  ...(failed.refusal === undefined ? {} : { refusal: coded(SHARD_REFUSALS, failed.refusal) }),
                } as const,
                settled: false,
              })
            ),
            Effect.timeoutOrElse({
              duration: options.within ?? "5 seconds",
              orElse: () => Effect.succeed({ result: { outcome: "timeout" } as const, settled: false }),
            }),
          )
          : { result: { outcome: "unavailable", reason: "invalid_target" } as const, settled: false }
        yield* Metric.update(Metric.withAttributes(writes, { write, outcome: result.outcome }), 1)
        // What was written, by id and outcome only: never a question's or an answer's text, nor who asked. Every
        // field is a fixed code, a status or a UUID: a reason or a refusal outside its list is `other`, and a
        // conversation id that is not a UUID is left out, so no text an answer or a caller held reaches a log line.
        // A note says whether it settled, since what was posted before it may be what the shard decided against.
        if (result.outcome !== "ok") {
          yield* Effect.logWarning("chat.shard.bridge").pipe(
            Effect.annotateLogs({
              write,
              ...(named ? { conversationId: conversationId.toLowerCase() } : {}),
              ...result,
              ...(note === undefined ? {} : { settled }),
            }),
          )
        }
        return { outcome: result.outcome, settled }
      }).pipe(Effect.withSpan("chat.shard.bridge", { attributes: { write } }))
    const outcomeOf = (result: NoteResult) => result.outcome
    // A UUID has equivalent case spellings; a message id and a key have one, as Postgres prints it.
    const lower = <A extends Exchange>(write: A): A => ({
      ...write,
      conversationId: write.conversationId.toLowerCase(),
      questionId: write.questionId.toLowerCase(),
      ...(isAsked(write) ? { answerId: write.answerId.toLowerCase() } : {}),
    })
    /** `id` when it is a UUID, as ChatApi's routes already hold every id to; a shard is named, and a key built, from nothing else. */
    const uuid = (id: string) => (isUuid(id) ? id : undefined)
    return MessagesShardBridge.of({
      asked: (asked) =>
        Effect.map(
          bridge("asked", asked.conversationId, [uuid(asked.questionId), uuid(asked.answerId)], () => exchangeSteps(lower(asked))),
          outcomeOf,
        ),
      answered: (answered) =>
        Effect.map(
          bridge("answered", answered.conversationId, [uuid(answered.questionId), uuid(answered.answerId)], () =>
            answeredSteps(lower(answered))),
          outcomeOf,
        ),
      noted: (noted) =>
        bridge(
          "noted",
          noted.conversationId,
          [
            uuid(noted.messageId),
            // A version is a count: nothing else is put in a key or a command.
            Number.isSafeInteger(noted.version) && noted.version >= 0 ? "version" : undefined,
            ...(noted.exchange === undefined
              ? []
              : [uuid(noted.exchange.questionId), ...(isAsked(noted.exchange) ? [uuid(noted.exchange.answerId)] : [])]),
          ],
          // The message's own exchange first, under the keys `asked` and `answered` used: duplicates when it was
          // bridged, and the message's first appearance when its note is the first the shard hears of it.
          () => (noted.exchange === undefined ? [] : stepsOf(lower(noted.exchange))),
          () => noteStep({ ...noted, messageId: noted.messageId.toLowerCase() }),
        ),
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

/** Bridges what the timeline wrote on a message, where a bridge is provided. Never fails. */
export const noted = (note: Noted): Effect.Effect<void> =>
  Effect.flatMap(Effect.serviceOption(MessagesShardBridge), (bridge) =>
    Option.isNone(bridge) ? Effect.void : Effect.asVoid(bridge.value.noted(note)))
