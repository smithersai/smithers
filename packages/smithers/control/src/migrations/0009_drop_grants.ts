/**
 * Drop the bulk-grant table nothing reads.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"

/** Drops `control_grants`. A decision's scope lives on its approval token;
 * the grant rows duplicated it for a reader that never existed.
 * @category migrations
 * @since 1.0.0
 */
export const dropGrants = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DROP TABLE IF EXISTS control_grants`
})
