import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// How each served model call ended, on its ledger row (docs/features/model-endpoint.md#budget). On 2026-10-25, 11 of
// the first 40 calls to a new provider settled at 0 tokens, and the ledger couldn't say whether each was an abort or a
// refusal. Written when the call settles; never content or provider text.
//
// - `outcome`: `answered`, `aborted` (its client went away), `refused` (its provider refused before any output) or
//   `failed` (any other failure). Rows settled before this migration, and calls that never settled, have none.
// - `error_code`: the failed call's model error code, such as `quota_exceeded`.
// - `http_status`: the provider's HTTP status, when it answered one.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    ALTER TABLE model_usage
      ADD COLUMN outcome text CHECK (outcome IN ('answered', 'aborted', 'refused', 'failed')),
      ADD COLUMN error_code text CHECK (error_code IS NULL OR length(error_code) <= 64),
      ADD COLUMN http_status integer CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599)`
})
