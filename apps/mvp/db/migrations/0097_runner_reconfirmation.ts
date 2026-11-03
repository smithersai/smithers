import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// What the runner cutover marks (ops/runner-cutover/cutover.ts, decision 0148): `reconfirm_at` on an agent or a
// repository's overflow, when the cutover asked an Admin to write it again. Null until then, so nothing changes for
// anyone until the cutover runs; an Admin's next write clears it. Nullable and with no default, so adding it rewrites
// no row; bounded, as `0095_runner_reauthorization` is, so a deploy that meets a long transaction on these tables fails
// and runs again rather than queueing their readers behind the lock it waits for.

/** How long the migration waits for a lock. */
export const LOCK_TIMEOUT = "5s"

/** The longest one of the migration's statements runs. */
export const STATEMENT_TIMEOUT = "60s"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [before] = yield* sql<{ readonly lock: string; readonly statement: string }>`
    SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement`
  yield* sql`SELECT set_config('lock_timeout', ${LOCK_TIMEOUT}, true), set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true)`
  yield* sql`ALTER TABLE agents ADD COLUMN reconfirm_at timestamptz`
  yield* sql`ALTER TABLE repo_overflow ADD COLUMN reconfirm_at timestamptz`
  yield* sql`SELECT set_config('lock_timeout', ${before!.lock}, true), set_config('statement_timeout', ${before!.statement}, true)`
})
