import { canonicalJson, MAX_PARTS, type MessageFailure, MessagePart, MessageRun } from "@smthrs/app-state"
import { Array as Arr, Effect, type Layer, Option, Schema } from "effect"
import { SqlClient, type Statement } from "effect/sql"
import * as MessagesShardBridge from "./MessagesShardBridge.ts"

// What ChatApi's bridge writes into a conversation's messages shard, read from Postgres once the write's transaction
// has committed (decision 0170, slice 5a). A caller names the row it wrote and nothing else: the place, the time and
// the text come from the committed row, so a write Postgres rolled back is never bridged, and the same write read again
// is the same commands under the same keys. Nothing here fails: a row that cannot be read is a log line, and the
// request that wrote it goes on.
//
// Every write of a message is owed to the shard from its commit: Postgres keeps one row per message the shard has not
// acknowledged (`messages_shard_pending`), written by triggers in the transaction that wrote the message: a question
// asked, an answer recorded, ended or changed, and the timeline's notes (db/migrations/0135_message_note_versions.ts,
// db/migrations/0139_messages_shard_pending.ts). ChatApi's own bridge of a question or an answer takes its rows away
// once the shard settled what it sent (`asked`, `answered`). `drain` sends whatever a conversation is still owed and
// takes a row away only once the shard has settled the message's exchange and, for a note, answered the note's own
// command for its version (`MessagesShardBridge.NoteResult`). It runs after each note is written and before each read
// of the shard (worker/chat/MessagesShardRoutes.ts `dispatch`), so a write whose request died between the commit and
// the send, or whose shard could not be reached, arrives with the next of either, without the write being made again.
// A row a send left owed is tried again after every row not yet tried.
//
// A conversation whose history Postgres held before the bridge is read whole once (`history`, `notes`), and replayed
// into its shard by the backfill (worker/chat/MessagesShardBackfill.vibe).

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
 * The exchanges Postgres holds now where `where` holds of a question `q`, in their place: each question alone when it
 * has no answer beside it, the pair when the answer still streams, and the answer's text, its last write and how it
 * ended once it has: finished, or failed and why. A question with more than one answer is one exchange per answer,
 * in the answers' place and then their ids, so every row Postgres holds is read and the same rows read again are the
 * same exchanges in the same order. At most `limit` exchanges, the first in that order, where a caller gives one.
 * Each time is as Postgres prints one in UTC, which is how Electric delivers it (src/features/chat/view.ts
 * `postgresTime`).
 *
 * The view a question was sent from, and the values sent with it, are read only where every reader of the conversation
 * already syncs them: a form, whose synced `state` names the question that submitted it and its values
 * (worker/Views.ts `askFrom`, `SYNCED_VIEW_COLUMNS`). A generated view's event and its values stay on the server, as
 * `messages.source` and `messages.data` do for every device (worker/Chat.ts `SYNCED_MESSAGE_COLUMNS`): a shard's posts
 * reach every reader of the conversation.
 */
const exchanges = (where: (sql: SqlClient.SqlClient) => ReadonlyArray<Statement.Fragment>, limit?: number) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<ExchangeRow>`
      SELECT q.conversation_id AS "conversationId", q.id AS "questionId", a.id AS "answerId",
        q.text, q.position::text AS position, (q.created_at AT TIME ZONE 'UTC')::text || '+00' AS "createdAt",
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
      WHERE ${sql.and([sql`q.role = 'user'`, ...where(sql)])}
      ORDER BY q.position, a.position, a.id${limit === undefined ? sql`` : sql` LIMIT ${limit}`}`
    return rows.map(exchangeOf)
  })

/** What Postgres holds of one exchange (`exchanges`), as the bridge is told it. */
const exchangeOf = (row: ExchangeRow): MessagesShardBridge.Exchange => {
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
  if (row.answerId === null) return lone
  const asked: MessagesShardBridge.Asked = {
    ...lone,
    answerId: row.answerId,
    answer: { position: Number(row.answerPosition), createdAt: row.answerCreatedAt! },
  }
  // An answer still streaming is the pending one. One that ended is what Postgres holds of it: its text, when it
  // was last written, what its run wrote that the reducer takes, and why it failed when it did. It is never rebuilt as
  // empty and streaming, and never without the steps and the usage a reader of Postgres is shown.
  if (row.answerStatus === "streaming") return asked
  const run = runOf(row.answerRun)
  return {
    ...asked,
    text: row.answerText!,
    updatedAt: row.answerUpdatedAt!,
    ...(row.answerFailure === null ? {} : { failure: row.answerFailure }),
    ...(Object.keys(run).length === 0 ? {} : { run }),
  }
}

/**
 * Question `questionId` with each of its answers as Postgres holds them now (`exchanges`): nothing when it holds no
 * such question, and the question alone when it has no answer.
 */
export const exchangesOf = (questionId: string, conversationId?: string) =>
  exchanges((sql) => [
    sql`q.id = ${questionId}`,
    // A caller that read the message's conversation first holds the exchange to it: an id another conversation
    // came to hold between the two reads is no exchange of this one.
    ...(conversationId === undefined ? [] : [sql`q.conversation_id = ${conversationId}`]),
  ])

/** Question `questionId` and its first answer as Postgres holds them now (`exchangesOf`), or nothing. */
export const exchange = (questionId: string, conversationId?: string) =>
  Effect.map(exchangesOf(questionId, conversationId), Arr.head)

/**
 * The first `limit` exchanges of conversation `conversationId` whose question Postgres placed after `after`, as
 * Postgres holds them now (`exchanges`), in Postgres's order.
 */
export const history = (conversationId: string, after: number, limit: number) =>
  exchanges((sql) => [sql`q.conversation_id = ${conversationId}`, sql`q.position > ${after}`], limit)

export interface NoteRow {
  readonly id: string
  readonly role: "user" | "assistant"
  readonly questionId: string | null
  readonly summary: string | null
  readonly summaryRevision: string | null
  readonly phase: string | null
  readonly arc: string | null
  readonly version: string
}

/**
 * The note a row of `messages` holds (`NoteRow`): its summary with its revision, its phase and its arc as Postgres
 * holds them, `""` for a mark it lacks, under the version Postgres counted for that row's notes.
 *
 * @throws {never}
 */
export const notedOf = (conversationId: string, row: NoteRow): MessagesShardBridge.Noted => ({
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
})

/**
 * The note on each message `ids` names in conversation `conversationId` that the timeline ever wrote one on
 * (`notedOf`), in Postgres's order: a summary, a phase or an arc it holds, or a version that says notes were written
 * and taken away since. None when `ids` names none.
 */
export const notes = (conversationId: string, ids: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    if (ids.length === 0) return []
    const rows = yield* sql<NoteRow>`
      SELECT id, role, question_id AS "questionId", summary, summary_revision AS "summaryRevision", phase, arc,
        notes_version::text AS version
      FROM messages
      WHERE conversation_id = ${conversationId}
        AND (summary IS NOT NULL OR phase IS NOT NULL OR arc IS NOT NULL OR notes_version > 0)
        AND id IN ${sql.in(ids)}
      ORDER BY position`
    return rows
  })

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

/**
 * One row of what the shard is owed (`messages_shard_pending`, db/migrations/0139_messages_shard_pending.ts): the
 * message, and `obligation`, which every write of the row raises. A row is taken away only under the obligation it
 * was read with, so a write committed while the shard was being sent the row stays owed.
 */
interface Owed {
  readonly id: string
  readonly obligation: string
}

/**
 * The answers a write owed to the shard is settled by: the shard sequenced it, held it already, or decided against it
 * with a receipt that answers it for ever (`MessagesShardBridge.Outcome`). An object that could not be reached, an
 * epoch that kept moving, a time out and a refusal by the object for what the command is leave it owed.
 */
const SETTLED: ReadonlySet<MessagesShardBridge.Outcome> = new Set(["ok", "kept", "refused", "idempotency_conflict"])

/** Takes away each of `owed` in conversation `conversationId`, only under the obligation it was read with. */
const settle = (conversationId: string, owed: ReadonlyArray<Owed>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.forEach(owed, (row) => sql`
      DELETE FROM messages_shard_pending
      WHERE conversation_id = ${conversationId} AND message_id = ${row.id} AND obligation = ${row.obligation}`, {
      discard: true,
    }))

/**
 * What question `questionId` and its answers are owed, of the rows ChatApi's own write settles: a message with notes
 * is owed them too, and only `drain` sends a note.
 */
const owedOf = (questionId: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<Owed>`
      SELECT p.message_id AS id, p.obligation::text AS obligation FROM messages_shard_pending p
      WHERE p.notes_version = 0
        AND p.message_id IN (SELECT m.id FROM messages m WHERE m.id = ${questionId} OR m.question_id = ${questionId})`)

/**
 * Reads what question `questionId` is owed, then each of its exchanges `pick` keeps, and bridges them with `send`:
 * the rows read first are taken away once every exchange is settled (`SETTLED`). Nothing found is `missing`.
 */
const exchanged = <A extends MessagesShardBridge.Exchange>(
  write: "asked" | "answered",
  questionId: string,
  pick: (exchange: MessagesShardBridge.Exchange) => exchange is A,
  send: (bridge: MessagesShardBridge.MessagesShardBridge["Service"], exchange: A) => Effect.Effect<MessagesShardBridge.Outcome>,
) =>
  bridged(
    write,
    Effect.gen(function*() {
      const owed = yield* owedOf(questionId)
      const found = (yield* exchangesOf(questionId)).filter(pick)
      return found.length === 0 ? Option.none() : Option.some({ owed, found })
    }),
    ({ owed, found }, bridge) =>
      Effect.gen(function*() {
        const outcomes = yield* Effect.forEach(found, (exchange) => send(bridge, exchange))
        if (outcomes.every((outcome) => SETTLED.has(outcome))) yield* settle(found[0]!.conversationId, owed)
      }),
  )

/**
 * Bridges question `questionId` and each pending answer as Postgres committed them, and takes away what they were
 * owed (`exchanged`). Never fails.
 */
export const asked = (questionId: string) =>
  exchanged("asked", questionId, MessagesShardBridge.isAsked, (bridge, found) => bridge.asked(found))

/** `asked`, reading through `database`, which is built only where a bridge is provided. */
export const askedIn = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>, questionId: string) =>
  Effect.flatMap(Effect.serviceOption(MessagesShardBridge.MessagesShardBridge), (service) =>
    Option.isNone(service)
      ? Effect.void
      : Effect.provide(asked(questionId), database).pipe(Effect.catchCause(() => unread("asked", "unreadable"))))

/**
 * Bridges each of question `questionId`'s ended answers as Postgres committed them, finished or failed, and the
 * question with them, and takes away what they were owed (`exchanged`). An answer Postgres still holds streaming is
 * not bridged. Never fails.
 */
export const answered = (questionId: string) =>
  exchanged("answered", questionId, MessagesShardBridge.isAnswered, (bridge, found) => bridge.answered(found))

/** The most messages one `drain` sends: what is left is sent by the next, so no request waits on a whole backlog. */
export const DRAIN_LIMIT = 64

/** Whether a row of `messages` holds notes the timeline wrote, or once wrote and took away (`notes`). */
const hasNotes = (row: NoteRow) => row.summary !== null || row.phase !== null || row.arc !== null || Number(row.version) > 0

/**
 * Sends conversation `conversationId`'s shard what it is owed, for at most `DRAIN_LIMIT` messages: every write Postgres
 * committed of a message, a question asked, an answer recorded or changed, or its notes, leaves its message owed from
 * that commit (`messages_shard_pending`), whatever becomes of the request that wrote it. Each owed message's exchange
 * is read as Postgres holds it now and replayed (`MessagesShardBridge.replayed`), every answer of a question, under
 * the bridge's own keys, so what the shard holds already answers `Duplicate`. Then a message with notes is sent them:
 * its summary with its revision, its phase and its arc as Postgres holds them now, `""` for a mark it lacks, under the
 * version Postgres counted for that row's notes. One row is one tuple, so the notes and their version are of one
 * commit: a read that sees a later write carries a higher version, and the shard keeps the highest whatever order the
 * reads arrive in.
 *
 * A message is no longer owed once the shard has settled every exchange it belongs to (`SETTLED`) and, where it has
 * notes, answered the note's own command for the version sent (`NoteResult.settled`), and only if Postgres has raised
 * no later obligation for it meanwhile: a write committed while this one was sent stays owed. Nothing else takes a row
 * away: not a command that could not be sent, and not a note whose exchange did not settle. Such a row stays owed, and
 * so does one whose message or exchange Postgres no longer holds in this conversation.
 *
 * The owed rows are read alone first, from their own index and without `messages`: a conversation that is owed
 * nothing, which is every read of a shard the bridge keeps up with, asks Postgres nothing else. The rows never tried
 * are sent first, oldest first, then the ones tried longest ago: a row left owed is marked tried, so it waits behind
 * every row that has not been, and 64 rows the shard keeps declining never hold a later one out of a drain. Never
 * fails.
 */
export const drain = (conversationId: string) =>
  bridged(
    "noted",
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const owed = yield* sql<Owed>`
        SELECT message_id AS id, obligation::text AS obligation FROM messages_shard_pending
        WHERE conversation_id = ${conversationId}
        ORDER BY attempted_at ASC NULLS FIRST, enqueued_at ASC, obligation ASC LIMIT ${DRAIN_LIMIT}`
      if (owed.length === 0) return Option.some({ owed, groups: [] })
      const rows = yield* sql<NoteRow>`
        SELECT id, role, question_id AS "questionId", summary, summary_revision AS "summaryRevision", phase, arc,
          notes_version::text AS version
        FROM messages WHERE conversation_id = ${conversationId} AND id IN ${sql.in(owed.map((row) => row.id))}`
      const obligations = new Map(owed.map((row) => [row.id, row.obligation]))
      // A question is its own exchange's; an answer's is its question's, which Postgres never lets it lack.
      const questions = Arr.dedupe(rows.map((row) => row.questionId ?? row.id))
      const groups = yield* Effect.forEach(questions, (questionId) =>
        Effect.map(exchangesOf(questionId, conversationId), (exchanges) => ({
          exchanges,
          rows: rows.filter((row) => (row.questionId ?? row.id) === questionId)
            .map((row) => ({ row, obligation: obligations.get(row.id)! })),
        })), { concurrency: 4 })
      return Option.some({ owed, groups })
    }),
    ({ owed, groups }, bridge) =>
      Effect.gen(function*() {
        if (owed.length === 0) return
        const settled = yield* Effect.forEach(groups, ({ exchanges, rows }) =>
          Effect.gen(function*() {
            const replays = yield* Effect.forEach(exchanges, (exchange) =>
              Effect.map(bridge.replayed(exchange, []), (replay) => ({
                answerId: MessagesShardBridge.isAsked(exchange) ? exchange.answerId : undefined,
                settled: replay.final && SETTLED.has(replay.outcome),
              })))
            return yield* Effect.forEach(rows, ({ row, obligation }) =>
              Effect.gen(function*() {
                // A question belongs to every exchange of its own, an answer to its own alone.
                const mine = replays.filter((replay) => row.role === "user" || replay.answerId === row.id)
                if (mine.length === 0 || !mine.every((replay) => replay.settled)) return []
                if (hasNotes(row) && !(yield* bridge.noted(notedOf(conversationId, row))).settled) return []
                return [{ id: row.id, obligation }]
              }))
          }), { concurrency: 4 })
        const done = settled.flat(2)
        yield* settle(conversationId, done)
        const left = new Set(done.map((row) => row.id))
        const pending = owed.map(({ id }) => id).filter((id) => !left.has(id))
        if (pending.length === 0) return
        const sql = yield* SqlClient.SqlClient
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
