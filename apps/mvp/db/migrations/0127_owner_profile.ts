import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// What GitHub says of a user or organization profile, kept for every data center (worker/profile/Store.ts):
// the last good answer (`profile`, the JSON the profile route serves), which token read it, when, and until when it is
// fresh; `next_read_at`, before which nobody asks GitHub, which one request claims at a time so many visitors cause one
// read; GitHub's last `refusal` and `refusal_via`, so a burst during an outage is answered without asking again; and
// `claim_generation`, the fencing token only the matching claimant can save or refuse under.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE owner_profile (
      owner text PRIMARY KEY CHECK (char_length(owner) BETWEEN 1 AND 39),
      profile text,
      via text CHECK (via IN ('deployment', 'anonymous')),
      read_at timestamptz,
      fresh_until timestamptz,
      next_read_at timestamptz,
      refusal text CHECK (refusal IN ('not_found', 'rate_limited', 'github_unavailable')),
      refusal_via text CHECK (refusal_via IN ('deployment', 'anonymous')),
      claim_generation bigint NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
      CHECK ((profile IS NULL) = (via IS NULL) AND (profile IS NULL) = (read_at IS NULL) AND (profile IS NULL) = (fresh_until IS NULL))
    )`
})
