import { Data, Effect } from "effect"
import { SqlClient } from "effect/sql"

// Admission of a person's question and its pending answer into the conversation transcript.

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
 * `askedBy` is the asking actor's person id from the session. A retry matches the question's role, text, answer id,
 * asker, conversation, view and values. An answer id already used by another message rejects both inserts.
 */
export const ask = (question: {
  readonly id: string
  readonly answerId: string
  readonly conversationId: string
  readonly text: string
  readonly askedBy: string
  /** The view it was sent from, and the event (worker/Views.ts `askFrom`). */
  readonly source?: { readonly viewId: string; readonly event: string }
  /** The values sent with it: a form's, or a view's message event's. */
  readonly data?: Readonly<Record<string, unknown>>
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const source = question.source === undefined ? null : JSON.stringify(question.source)
    const data = question.data === undefined ? null : JSON.stringify(question.data)
    return yield* sql.withTransaction(Effect.gen(function* () {
      yield* sql`SELECT id FROM conversations WHERE id = ${question.conversationId} FOR UPDATE`
      const [inserted] = yield* sql<{ readonly txid: string }>`
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
        RETURNING pg_current_xact_id()::xid::text AS txid`
      if (inserted !== undefined) {
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

/** Serializes a run report with transcript writes in the answer's conversation. */
export const withAnswerConversation = <A, E, R>(answerId: string, use: Effect.Effect<A, E, R>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(Effect.gen(function* () {
    yield* sql`SELECT c.id FROM conversations c JOIN messages a ON a.conversation_id = c.id
      WHERE a.id = ${answerId} FOR UPDATE OF c`
    return yield* use
  })))
