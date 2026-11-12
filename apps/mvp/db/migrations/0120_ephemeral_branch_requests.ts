import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// A new ephemeral branch a request asks for (`POST /api/branches` with `create` and `request`) is claimed here before
// Code Storage writes it, and the claim is removed in the transaction that tracks it. A request that answered nothing
// after the write finds its claim and tracks the ref it made; no other request may claim that name meanwhile.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE ephemeral_branch_requests (
    id uuid PRIMARY KEY, person_id text NOT NULL, repo_id text NOT NULL, ref text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (repo_id, ref)
  )`
})
