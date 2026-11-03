import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Budget reservations (docs/features/model-endpoint.md#budget). The endpoint read today's spend before a call and
// recorded it after, so calls in flight at once all passed the read and overshot the budget together. Now each call
// reserves its worst case before the model runs and settles to what it spent when it ends, and the day's total is one
// counter row, `model_budget_days`, which a reservation checks and raises in one statement. Nothing here is synced to
// browsers.
//
// `model_usage` becomes the ledger of those calls: the UTC `day` a call reserved on, the `reserved_tokens` it held,
// and `settled_at` once it settled to its actual `input_tokens` and `output_tokens`. A day's `committed` is its settled
// calls' spend plus its unsettled calls' reservations. Every row written before this migration was metered after its
// call ended, so it is settled, reserved nothing, and seeds its day's counter.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE model_budget_days (
      day date PRIMARY KEY,
      committed bigint NOT NULL CHECK (committed >= 0)
    )`
  yield* sql`ALTER TABLE model_usage ADD COLUMN day date`
  yield* sql`ALTER TABLE model_usage ADD COLUMN reserved_tokens integer NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0)`
  yield* sql`ALTER TABLE model_usage ADD COLUMN settled_at timestamptz`
  yield* sql`UPDATE model_usage SET day = (created_at AT TIME ZONE 'UTC')::date, settled_at = created_at`
  yield* sql`ALTER TABLE model_usage ALTER COLUMN day SET NOT NULL`
  yield* sql`
    INSERT INTO model_budget_days (day, committed)
    SELECT day, sum(input_tokens + output_tokens) FROM model_usage GROUP BY day`
})
