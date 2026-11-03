import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Model spend alerts (docs/features/spend-alerts.md). Any model spend alerts the deployment's Admins, at most once a
// window: the first call admitted in a window starts `ops/SpendAlert` for it, which waits for the window to end, then
// claims every ledger row no alert has carried yet and records one `spend_alerts` row with their tokens and estimated
// cost by role. Admins' devices sync the rows (decision 0009's feed will route them once it exists).
//
// `model_usage.spend_alert_id` is the alert that carried a call. Rows written before this migration are marked as
// carried, so the first alert reports only what came after it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE model_usage ADD COLUMN spend_alert_id text`
  yield* sql`UPDATE model_usage SET spend_alert_id = 'before_spend_alerts'`
  // The claim reads only the calls no alert carried yet.
  yield* sql`CREATE INDEX model_usage_unalerted ON model_usage (created_at) WHERE spend_alert_id IS NULL`
  yield* sql`
    CREATE TABLE spend_alerts (
      id text PRIMARY KEY,
      kind text NOT NULL DEFAULT 'model' CHECK (kind IN ('model')),
      audience text NOT NULL DEFAULT 'admin' CHECK (audience IN ('admin')),
      window_start timestamptz NOT NULL,
      window_end timestamptz NOT NULL CHECK (window_end > window_start),
      calls integer NOT NULL CHECK (calls > 0),
      tokens bigint NOT NULL CHECK (tokens >= 0),
      cost_usd double precision CHECK (cost_usd >= 0),
      roles jsonb NOT NULL CHECK (jsonb_typeof(roles) = 'array'),
      day_tokens bigint NOT NULL CHECK (day_tokens >= 0),
      budget bigint NOT NULL CHECK (budget > 0),
      created_at timestamptz NOT NULL DEFAULT now()
    )`
  // The shape reads an audience's rows.
  yield* sql`CREATE INDEX spend_alerts_audience ON spend_alerts (audience, created_at)`
  // Electric sends whole rows on update and delete, so it needs no superuser to set this itself.
  yield* sql`ALTER TABLE spend_alerts REPLICA IDENTITY FULL`
})
