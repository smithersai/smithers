/**
 * Removes the redundant plan node ordering index.
 *
 * The unique index from `0002_append_only_hardening` covers the same
 * `(plan_id, ordinal)` columns as the initial nonunique index, so it
 * supports ordered reads while enforcing ordinal uniqueness.
 *
 * This package reserves migration id block `4000`, so this migration is id
 * `4004`.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"

/**
 * Drops the nonunique index while retaining the unique ordinal index.
 *
 * @private
 * @since 0.1.0
 * @slop
 */
export const removeRedundantIndex: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DROP INDEX flows_plan_nodes_order`
})
