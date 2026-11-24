/** @since 1.0.0-rc.18 */

import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"

/**
 * Indexes `flows_trigger_fires` in the order `TriggerStore.history` reads it:
 * newest occurrence first, then descending trigger id. Without it every
 * unfiltered fires listing sorted the whole ledger to answer one page, and a
 * keyset cursor had no index to seek on.
 *
 * A named export rather than `export default`: the CommonJS build reads a
 * default import of a sibling module as the whole exports object, so the
 * migrator received `{ default }` instead of this Effect.
 *
 * @category migrations
 * @since 1.0.0-rc.18
 */
export const fireNewestIndex: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE INDEX IF NOT EXISTS flows_trigger_fires_newest
    ON flows_trigger_fires (occurrence_at_ms DESC, trigger_id DESC)`
})
