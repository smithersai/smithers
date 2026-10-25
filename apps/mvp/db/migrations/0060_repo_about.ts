import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// What GitHub says of a repository, kept for every data center (worker/about/Store.ts, docs/features/repo.md#about):
// the last good answer (`about`, the JSON the about route serves), which token read it, when, and until when it is
// fresh; `next_read_at`, before which nobody asks GitHub, which one request claims at a time so many visitors cause one
// read; GitHub's last `refusal`, so a burst during an outage is answered without asking again; and `app_absent_until`,
// when the Smithers App was found not installed. It replaced the Workers Cache API, which each data center keeps apart.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE repo_about (
      repo_id text PRIMARY KEY CHECK (char_length(repo_id) BETWEEN 1 AND 300),
      about text,
      via text CHECK (via IN ('app', 'deployment', 'anonymous')),
      read_at timestamptz,
      fresh_until timestamptz,
      next_read_at timestamptz,
      refusal text CHECK (refusal IN ('not_found', 'rate_limited', 'github_unavailable')),
      app_absent_until timestamptz,
      CHECK ((about IS NULL) = (via IS NULL) AND (about IS NULL) = (read_at IS NULL) AND (about IS NULL) = (fresh_until IS NULL))
    )`
})
