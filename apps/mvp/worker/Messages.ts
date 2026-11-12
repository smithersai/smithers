import { Data, Effect } from "effect"
import { SqlClient } from "effect/sql"

// The statements ChatApi runs on the `messages` table when someone asks, and the history an answer's turn reads
// (db/migrations, docs/features/chat.md#contract). The answer routes' own writes are in worker/Answers.ts.

/** What the model sees at most: this many finished exchanges, of at most this many characters in all. */
const MAX_EXCHANGES = 19
const MAX_HISTORY_CHARACTERS = 24_000

/**
 * What the agent reads after a question sent from a form or a view, before the values sent with it as JSON: the
 * question's text is the submit label, so the values are what it asks about (docs/features/views.md#forms).
 */
export const SENT_VALUES = "\nThe values the person sent with it: "

/** One finished exchange of the conversation. */
export interface Exchange {
  readonly question: string
  readonly answer: string
}

/** A question's id is taken by a different message: another question, another answer id, or an answer. */
export class IdTaken extends Data.TaggedError("IdTaken")<{}> {}

/** What asking did: inserted both rows in the transaction `txid`, or found this exact question asked (`null`). */
type Asked = { readonly txid: number | null }

/**
 * Inserts the question and its empty streaming answer in one statement, so in one transaction, both in the
 * conversation `conversationId` (decision 0013 §1). The question draws its
 * position from the identity, which steps by 2, and the answer takes the next one, so no other row lands between them
 * (db/migrations/0003_paired_positions.ts). A conversation lock precedes allocation and lasts through commit,
 * so no later pair can become visible ahead of an earlier pair. Ids are lowercase, as Postgres prints them.
 * `askedBy` is the asking actor's person id, from the session (worker/Chat.ts): only that person may write the answer
 * (worker/Answers.ts). When a message with the question's id exists, nothing changes: it is a retry if it is the same
 * question (role `user`, same text, same answer id, same asker, same conversation, same view and values), and
 * `IdTaken` otherwise. An answer id another message
 * has fails the statement with a unique violation, and nothing is written.
 *
 * `admit` runs inside that transaction once the pair is inserted, before it commits, with the transaction's own id as
 * the `attempt`: ChatApi starts the answer's expiry there (worker/Chat.ts), so no answer is ever stored without one.
 * When it fails, nothing is written. The transaction holds the answer's ask lock ({@link lockAsk}) from its start.
 */
export const ask = <E = never, R = never>(question: {
  readonly id: string
  readonly answerId: string
  readonly conversationId: string
  readonly text: string
  readonly askedBy: string
  /** The view it was sent from, and the event (worker/Views.ts `askFrom`). */
  readonly source?: { readonly viewId: string; readonly event: string }
  /** The values sent with it: a form's, or a view's message event's. */
  readonly data?: Readonly<Record<string, unknown>>
}, admit: (attempt: string) => Effect.Effect<void, E, R> = () => Effect.void) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const source = question.source === undefined ? null : JSON.stringify(question.source)
    const data = question.data === undefined ? null : JSON.stringify(question.data)
    return yield* sql.withTransaction(Effect.gen(function* () {
      yield* lockAsk(question.answerId)
      yield* sql`SELECT id FROM conversations WHERE id = ${question.conversationId} FOR UPDATE`
      const [inserted] = yield* sql<{ readonly txid: string; readonly attempt: string }>`
        WITH question AS (
          INSERT INTO messages (id, role, text, status, asked_by, conversation_id, source, data)
          VALUES (${question.id}, 'user', ${question.text}, 'done', ${question.askedBy}, ${question.conversationId},
            ${source}::jsonb, ${data}::jsonb)
          ON CONFLICT (id) DO NOTHING
          RETURNING position
        )
        INSERT INTO messages (id, role, status, question_id, position, conversation_id) OVERRIDING SYSTEM VALUE
        SELECT ${question.answerId}, 'assistant', 'streaming', ${question.id}, position + 1, ${question.conversationId}
        FROM question
        RETURNING pg_current_xact_id()::xid::text AS txid, pg_current_xact_id()::text AS attempt`
      if (inserted !== undefined) {
        yield* admit(inserted.attempt)
        return { txid: Number(inserted.txid) } satisfies Asked
      }
      const [existing] = yield* sql<{
        readonly role: string
        readonly text: string
        readonly answerId: string | null
        readonly askedBy: string | null
        readonly conversationId: string
        readonly sameView: boolean
      }>`
        SELECT q.role, q.text, a.id AS "answerId", q.asked_by AS "askedBy", q.conversation_id AS "conversationId",
          q.source IS NOT DISTINCT FROM ${source}::jsonb AND q.data IS NOT DISTINCT FROM ${data}::jsonb AS "sameView"
        FROM messages q LEFT JOIN messages a ON a.question_id = q.id
        WHERE q.id = ${question.id}`
      const same = existing !== undefined && existing.role === "user" && existing.text === question.text &&
        existing.answerId === question.answerId && existing.askedBy === question.askedBy &&
        existing.conversationId === question.conversationId && existing.sameView
      if (!same) return yield* new IdTaken()
      return { txid: null } satisfies Asked
    }))
  })

/**
 * The history the model sees before an answer, oldest first: the most recent finished (`done`) exchanges before
 * it in its own conversation, stopping at the first one, going back, that would pass `MAX_EXCHANGES` or `MAX_HISTORY_CHARACTERS`.
 * A question sent from a view counts with its values, as the model reads it.
 */
export const history = (answerId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<Exchange>`
      SELECT question, answer FROM (
        SELECT asked.question, a.text AS answer, a.position,
          sum(char_length(asked.question) + char_length(a.text)) OVER (ORDER BY a.position DESC) AS characters
        FROM messages a JOIN messages q ON q.id = a.question_id
        CROSS JOIN LATERAL (
          SELECT q.text || CASE WHEN q.data IS NULL THEN '' ELSE ${SENT_VALUES}::text || q.data::text END AS question
        ) asked
        JOIN messages t ON t.id = ${answerId}
        WHERE a.status = 'done' AND a.conversation_id = t.conversation_id AND a.position < t.position
        ORDER BY a.position DESC
        LIMIT ${MAX_EXCHANGES}
      ) recent
      WHERE characters <= ${MAX_HISTORY_CHARACTERS}
      ORDER BY position`
  })

/**
 * Takes the ask lock of `answerId` until the transaction around it ends: an advisory lock on the id. The transaction
 * that stores an answer holds it from before the insert through its commit ({@link ask}), and `chat/Expire` takes it
 * before it looks for the answer (worker/flows/Expire.ts). So an expiry started inside an ask that hasn't committed
 * waits for the commit, and never reads the answer as missing while it is being stored.
 */
export const lockAsk = (answerId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql`SELECT pg_advisory_xact_lock(hashtextextended(${answerId}, 0))`,
  )

/** Serialize admission, heartbeat, terminal writes and durable expiry in one
 * conversation. The row is locked before taking the statement's liveness
 * snapshot, so an expiry cannot abandon an answer renewed while it waited.
 * Missing ids lock nothing and remain the caller's ordinary not-found path. */
export const withAnswerConversation = <A, E, R>(answerId: string, use: Effect.Effect<A, E, R>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(Effect.gen(function* () {
    yield* sql`SELECT c.id FROM conversations c JOIN messages a ON a.conversation_id = c.id
      WHERE a.id = ${answerId} FOR UPDATE OF c`
    return yield* use
  })))
