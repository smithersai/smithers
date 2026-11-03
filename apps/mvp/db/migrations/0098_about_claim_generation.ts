import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// An About reader's fencing token outlives its answer, including a not_found that clears read_at.
// Claims and terminal writes advance it; only the matching claimant can save or refuse a read.
// Bound: old writers during one deploy overlap remain outside this fence; a stalled old-worker
// write lives for one claim. Rolling back to an old worker also removes the fence.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE repo_about ADD COLUMN claim_generation bigint NOT NULL DEFAULT 0 CHECK (claim_generation >= 0)`
})
