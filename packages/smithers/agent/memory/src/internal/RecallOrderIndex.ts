/**
 * The sixth memory migration: the index a newest-first fact page reads.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"

/**
 * Indexes facts in the order recall pages them: one namespace, newest update
 * first, key ascending within a timestamp. Without it every 512-row page of a
 * bank sorts the whole bank again. Notes already hold the matching
 * `memory_notes_namespace_order_idx`. The statement is idempotent.
 *
 * @category migrations
 * @since 1.0.0
 */
export const recallOrderIndex = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE INDEX IF NOT EXISTS memory_facts_recall_order_idx
    ON memory_facts (namespace_kind, namespace_id, updated_at_ms DESC, fact_key)`
})
