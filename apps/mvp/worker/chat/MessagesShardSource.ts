import { canonicalJson, MAX_PARTS, type MessageFailure, MessagePart, MessageRun } from "@smthrs/app-state"
import { Array as Arr, Effect, type Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import * as MessagesShardBridge from "./MessagesShardBridge.ts"

// What ChatApi's bridge writes into a conversation's messages shard, read from Postgres once the write's transaction
// has committed (decision 0170, slice 5a). A caller names the row it wrote and nothing else: the place, the time and
// the text come from the committed row, so a write Postgres rolled back is never bridged, and the same write read again
// is the same commands under the same keys. Nothing here fails: a row that cannot be read is a log line, and the
// request that wrote it goes on.
//
// A note the timeline writes is owed to the shard from its commit: Postgres keeps one row per message whose notes the
// shard has not acknowledged (`messages_shard_pending`, written by a trigger in the transaction that wrote the note:
// db/migrations/0135_message_note_versions.ts). `drain` sends what a conversation is owed and takes a row away only
// once the shard has answered the note's own command for its version (`MessagesShardBridge.NoteResult`). It runs after
// each note is written and before each read of the shard (worker/chat/MessagesShardRoutes.ts `dispatch`), so a note
// whose request died between the commit and the send, or whose shard could not be reached, arrives with the next of
// either, without the write being made again. A row a send left owed is tried again after every row not yet tried.

interface ExchangeRow {
  readonly conversationId: string
  readonly questionId: string
  readonly answerId: string | null
  readonly text: string
  readonly position: string
  readonly createdAt: string
  readonly source: { readonly viewId: string; readonly event: string } | null
  readonly data: Readonly<Record<string, unknown>> | null
  readonly answerText: string | null
  readonly answerStatus: "done" | "streaming" | "failed" | null
  readonly answerFailure: MessageFailure | null
  readonly answerPosition: string | null
  readonly answerCreatedAt: string | null
  readonly answerUpdatedAt: string | null
  readonly answerRun: Readonly<Record<string, unknown>>
}

/**
 * What an answer's run wrote, as the shard's reducer takes it (`@smthrs/app-state` `MessageRun`, less why it failed,
 * which is read beside it): its steps, its model, why it stopped and its token counts. Each field is held to the
 * reducer's bounds on its own, so one Postgres holds outside them (an answer stored before the bounds were) takes
 * nothing else with it: a model name too long is left out, and the steps, the stop reason and the counts beside it
 * are kept. Steps are kept from the first, up to the first the reducer takes none of and no more than it records
 * (`MAX_PARTS`): the steps an answer took in order, never a later one without the one before it.
 */
const { failure: _failure, parts: _parts, ...scalarFields } = MessageRun.fields
const scalars = Object.entries(scalarFields).map(([key, field]) =>
  [key, Schema.decodeUnknownOption(Schema.Struct({ [key]: field }))] as const)
const isPart = Schema.is(MessagePart)
export const runOf = (held: Readonly<Record<string, unknown>>): Omit<MessageRun, "failure"> => {
  const steps: ReadonlyArray<unknown> = Array.isArray(held.parts) ? held.parts : []
  const unfit = steps.findIndex((step) => !isPart(step))
  const parts = steps.slice(0, Math.min(unfit === -1 ? steps.length : unfit, MAX_PARTS)).filter(isPart)
  return Object.assign(
    parts.length === 0 ? {} : { parts },
    ...scalars.map(([key, decode]) => Option.getOrElse(decode({ [key]: held[key] }), () => ({}))),
  ) as Omit<MessageRun, "failure">
}

/**
 * Question `questionId` and its answer as Postgres holds them now, or nothing when it holds no such question: the
 * question alone when it has no answer beside it, the pair when the answer still streams, and the answer's text, its
 * last write and how it ended once it has: finished, or failed and why. Each time is as Postgres prints one in UTC,
 * which is how Electric delivers it (src/features/chat/view.ts `postgresTime`).
 *
 * The view a question was sent from, and the values sent with it, are read only where every reader of the conversation
 * already syncs them: a form, whose synced `state` names the question that submitted it and its values
 * (worker/Views.ts `askFrom`, `SYNCED_VIEW_COLUMNS`). A generated view's event and its values stay on the server, as
 * `messages.source` and `messages.data` do for every device (worker/Chat.ts `SYNCED_MESSAGE_COLUMNS`): a shard's posts
 * reach every reader of the conversation.
 */
export const exchange = (questionId: string, conversationId?: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<ExchangeRow>`
      SELECT q.conversation_id AS "conversationId", q.id AS "questionId", a.id AS "answerId", q.text,
        q.position::text AS position, (q.created_at AT TIME ZONE 'UTC')::text || '+00' AS "createdAt",
        CASE WHEN v.id IS NOT NULL THEN q.source END AS source,
        CASE WHEN v.id IS NOT NULL THEN q.data END AS data,
        a.text AS "answerText", a.status AS "answerStatus", a.failure AS "answerFailure",
        a.position::text AS "answerPosition",
        (a.created_at AT TIME ZONE 'UTC')::text || '+00' AS "answerCreatedAt",
        (a.updated_at AT TIME ZONE 'UTC')::text || '+00' AS "answerUpdatedAt",
        jsonb_strip_nulls(jsonb_build_object('parts', NULLIF(a.parts, '[]'::jsonb), 'modelId', a.model_id,
          'stopReason', a.stop_reason, 'inputTokens', a.input_tokens, 'outputTokens', a.output_tokens)) AS "answerRun"
      FROM messages q
      LEFT JOIN messages a ON a.question_id = q.id AND a.role = 'assistant' AND a.conversation_id = q.conversation_id
      LEFT JOIN views v ON v.id::text = q.source->>'viewId' AND v.conversation_id = q.conversation_id
        AND v.template = 'form' AND v.state->>'questionId' = q.id::text
      WHERE ${sql.and([
        sql`q.id = ${questionId}`,
        sql`q.role = 'user'`,
        // A caller that read the message's conversation first holds the exchange to it: an id another conversation
        // came to hold between the two reads is no exchange of this one.
        ...(conversationId === undefined ? [] : [sql`q.conversation_id = ${conversationId}`]),
      ])}
      ORDER BY a.position LIMIT 1`
    if (row === undefined) return Option.none<MessagesShardBridge.Exchange>()
    const lone: MessagesShardBridge.Lone = {
      conversationId: row.conversationId,
      questionId: row.questionId,
      question: {
        text: row.text,
        position: Number(row.position),
        createdAt: row.createdAt,
        ...(row.source === null ? {} : { source: { viewId: row.source.viewId, event: row.source.event } }),
        // One spelling of the values, whatever order Postgres keeps their keys in: the same row, the same command.
        ...(row.data === null ? {} : { data: canonicalJson(row.data) }),
      },
    }
    // A question Postgres holds with no answer beside it is bridged alone.
    if (row.answerId === null) return Option.some<MessagesShardBridge.Exchange>(lone)
    const asked: MessagesShardBridge.Asked = {
      ...lone,
      answerId: row.answerId,
      answer: { position: Number(row.answerPosition), createdAt: row.answerCreatedAt! },
    }
    // An answer still streaming is the pending one. One that ended is what Postgres holds of it: its text, when it
    // was last written, what its run wrote that the reducer takes, and why it failed when it did. It is never rebuilt as empty and streaming,
    // and never without the steps and the usage a reader of Postgres is shown.
    if (row.answerStatus === "streaming") return Option.some<MessagesShardBridge.Exchange>(asked)
    const run = runOf(row.answerRun)
    return Option.some<MessagesShardBridge.Exchange>({
      ...asked,
      text: row.answerText!,
      updatedAt: row.answerUpdatedAt!,
      ...(row.answerFailure === null ? {} : { failure: row.answerFailure }),
      ...(Object.keys(run).length === 0 ? {} : { run }),
    })
  })

interface NoteRow {
  readonly id: string
  readonly role: "user" | "assistant"
  readonly questionId: string | null
  readonly summary: string | null
  readonly summaryRevision: string | null
  readonly phase: string | null
  readonly arc: string | null
  readonly version: string
}

/** What a read that failed, or found nothing to bridge, leaves behind: a fixed code and the write's kind, never a row. */
const unread = (write: "asked" | "answered" | "noted", reason: "unreadable" | "missing") =>
  Effect.logWarning("chat.shard.bridge").pipe(Effect.annotateLogs({ write, outcome: "unread", reason }))

/** Runs `bridge` over what `read` finds, only where a bridge is provided: a deployment with none asks Postgres nothing. */
const bridged = <A, E, R>(
  write: "asked" | "answered" | "noted",
  read: Effect.Effect<Option.Option<A>, E, R>,
  bridge: (found: A, to: MessagesShardBridge.MessagesShardBridge["Service"]) => Effect.Effect<unknown, unknown, R>,
): Effect.Effect<void, never, R> =>
  Effect.flatMap(Effect.serviceOption(MessagesShardBridge.MessagesShardBridge), (service) =>
    Option.isNone(service) ? Effect.void : read.pipe(
      Effect.flatMap((found) => Option.isNone(found) ? unread(write, "missing") : Effect.asVoid(bridge(found.value, service.value))),
      // Whatever went wrong reading is kept out of the log: a driver's error can quote the row.
      Effect.catchCause(() => unread(write, "unreadable")),
    ))

/** The pair a found exchange holds: nothing for a question with no answer beside it. */
const pairOf = (found: MessagesShardBridge.Exchange): Option.Option<MessagesShardBridge.Asked> =>
  MessagesShardBridge.isAsked(found) ? Option.some(found) : Option.none()

/** Bridges question `questionId` and its pending answer as Postgres committed them. Never fails. */
export const asked = (questionId: string) =>
  bridged("asked", Effect.map(exchange(questionId), Option.flatMap(pairOf)), (found, bridge) => bridge.asked(found))

/** `asked`, reading through `database`, which is built only where a bridge is provided. */
export const askedIn = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, questionId: string) =>
  bridged(
    "asked",
    Effect.provide(Effect.map(exchange(questionId), Option.flatMap(pairOf)), database),
    (found, bridge) => bridge.asked(found),
  )

/**
 * Bridges question `questionId`'s ended answer as Postgres committed it, finished or failed, and the question with it.
 * An answer Postgres still holds streaming is not bridged. Never fails.
 */
export const answered = (questionId: string) =>
  bridged(
    "answered",
    Effect.map(exchange(questionId), Option.filter(MessagesShardBridge.isAnswered)),
    (found, bridge) => bridge.answered(found),
  )

/** The most notes one `drain` sends: what is left is sent by the next, so no request waits on a whole backlog. */
export const DRAIN_LIMIT = 64

/**
 * Sends conversation `conversationId`'s shard the notes it is owed, at most `DRAIN_LIMIT` of them: for each message
 * Postgres keeps as pending, its summary with its revision, its phase and its arc as Postgres holds them now, `""` for
 * a mark it lacks, under the version Postgres counted for that row's notes. One row is one tuple, so the notes and
 * their version are of one commit: a read that sees a later write carries a higher version, and the shard keeps the
 * highest whatever order the reads arrive in. Each note is sent with the exchange its message belongs to, read the
 * same way and held to this conversation, so the shard holds the message before it is told the note.
 *
 * A message is no longer pending once the shard has answered the note's own command for the version sent
 * (`NoteResult.settled`), and only if Postgres has counted no later one meanwhile: a note written while this one was
 * sent stays owed. Nothing else takes a row away: not a command posted before the note that the shard decided
 * against, and not a note that could not be sent. Such a row stays pending, and so does one whose exchange Postgres
 * no longer holds in this conversation.
 *
 * The rows never tried are sent first, oldest first, then the ones tried longest ago: a row left owed is marked
 * tried, so it waits behind every row that has not been, and 64 rows the shard keeps declining never hold a later
 * one out of a drain. Never fails.
 */
export const drain = (conversationId: string) =>
  bridged(
    "noted",
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<NoteRow>`
        SELECT m.id, m.role, m.question_id AS "questionId", m.summary,
          m.summary_revision AS "summaryRevision", m.phase, m.arc, m.notes_version::text AS version
        FROM messages_shard_pending p JOIN messages m ON m.id = p.message_id AND m.conversation_id = p.conversation_id
        WHERE p.conversation_id = ${conversationId}
        ORDER BY p.attempted_at ASC NULLS FIRST, p.enqueued_at ASC, m.position ASC LIMIT ${DRAIN_LIMIT}`
      return Option.some(
        yield* Effect.forEach(rows, (row) =>
          // A question is its own exchange's; an answer's is its question's, which Postgres never lets it lack.
          Effect.map(exchange(row.questionId ?? row.id, conversationId), (found) => ({
            id: row.id,
            note: Option.map(found, (held): MessagesShardBridge.Noted => ({
              conversationId,
              messageId: row.id,
              role: row.role,
              version: Number(row.version),
              notes: {
                // A summary Postgres does not hold was never recorded: nothing to say of it.
                ...(row.summary === null || row.summaryRevision === null
                  ? {}
                  : { summary: row.summary, summaryRevision: row.summaryRevision }),
                phase: row.phase ?? "",
                arc: row.arc ?? "",
              },
              exchange: held,
            })),
          })), { concurrency: 4 }),
      )
    }),
    (rows, bridge) =>
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        // A row whose exchange left this conversation between the two reads has no note: it is sent nothing.
        const settled = yield* Effect.forEach(Arr.getSomes(rows.map(({ note }) => note)), (note) =>
          Effect.gen(function*() {
            if (!(yield* bridge.noted(note)).settled) return []
            // Only the version sent is settled, and only in this conversation: a later write of the row's notes
            // raised the pending row's past it.
            yield* sql`
              DELETE FROM messages_shard_pending
              WHERE conversation_id = ${conversationId} AND message_id = ${note.messageId}
                AND notes_version <= ${note.version}`
            return [note.messageId]
          }), { concurrency: 4 })
        const done = new Set(settled.flat())
        const pending = rows.map(({ id }) => id).filter((id) => !done.has(id))
        if (pending.length === 0) return
        // Tried, and still owed: behind every row not tried yet, so the next drain starts with those.
        yield* sql`
          UPDATE messages_shard_pending SET attempted_at = clock_timestamp()
          WHERE conversation_id = ${conversationId} AND message_id IN ${sql.in(pending)}`
        // What stays owed is counted, never named: the next write or read of the conversation sends it.
        yield* Effect.logWarning("chat.shard.bridge").pipe(
          Effect.annotateLogs({ write: "noted", outcome: "pending", pending: pending.length }),
        )
      }),
  )

/**
 * `drain`, reading through `database`, which is built only where a bridge is provided: what a read of the shard runs
 * first (worker/ChatApiProgram.ts). A database that cannot be built is a log line too, and the read goes on.
 */
export const drainIn = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, conversationId: string) =>
  Effect.flatMap(Effect.serviceOption(MessagesShardBridge.MessagesShardBridge), (service) =>
    Option.isNone(service)
      ? Effect.void
      : Effect.provide(drain(conversationId), database).pipe(Effect.catchCause(() => unread("noted", "unreadable"))))
