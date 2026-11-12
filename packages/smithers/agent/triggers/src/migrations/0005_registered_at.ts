/** @since 1.0.0-rc.18 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"

/**
 * Adds `registered_at_ms`, the instant a trigger id was first registered.
 *
 * It is the durable baseline catch-up starts from until the trigger fires.
 * Without it a never-fired trigger started from whichever process saw it
 * first, so a restart across its first boundary lost that occurrence. Rows
 * that predate the column stay `NULL` until they are registered again.
 *
 * A named export rather than `export default`: the CommonJS build reads a
 * default import of a sibling module as the whole exports object, so the
 * migrator received `{ default }` instead of this Effect.
 *
 * @category migrations
 * @since 1.0.0-rc.18
 */
export const registeredAt: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE flows_triggers ADD COLUMN registered_at_ms ${Dialect.integer(sql)}`
})
