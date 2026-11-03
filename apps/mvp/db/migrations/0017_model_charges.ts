import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Unknown model spend (docs/features/model-endpoint.md#budget). A call settled to zero when the model never reported
// what it spent, so a call cancelled after its output, before its usage, cost the budget nothing (Codex review 4, P1).
// Now a call whose usage is unknown keeps its reservation, and a reservation that never settles is final once it
// expires: no statement settles it after that, so a late settle can't refund it, and nothing sweeps it.
//
// `charged_tokens` is what a call counts against its day: its reservation until it settles, then what it spent, or its
// reservation (at least) when what it spent is unknown. A day's `committed` is the sum of its calls' charges.
// `expires_at` is when its reservation becomes final. Rows written before this migration are charged what they settled
// to, or their reservation while unsettled, and expire an hour after they were made, the endpoint's default.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE model_usage ADD COLUMN charged_tokens integer CHECK (charged_tokens >= 0)`
  yield* sql`ALTER TABLE model_usage ADD COLUMN expires_at timestamptz`
  yield* sql`
    UPDATE model_usage SET
      charged_tokens = CASE WHEN settled_at IS NULL THEN reserved_tokens ELSE input_tokens + output_tokens END,
      expires_at = created_at + interval '1 hour'`
  yield* sql`ALTER TABLE model_usage ALTER COLUMN charged_tokens SET NOT NULL, ALTER COLUMN expires_at SET NOT NULL`
})
