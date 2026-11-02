import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// When GitHub last confirmed a session's role (worker/SessionStore.ts `setRole`, sign-in's own read): what a socket's
// lease trusts a role for (worker/SocketAccess.ts). `role_checked_at` also moves when a check couldn't reach GitHub
// (`keepRole`), so it can't say the role is still true, and nothing is copied from it: every existing session starts
// unconfirmed (null), and its next request starts a real check (worker/SignIn.ts). A failed check never moves it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // The ALTER takes the table's ACCESS EXCLUSIVE lock: a deploy that can't get it soon fails and is run again. The new
  // column is null, so it rewrites nothing.
  yield* sql`SET LOCAL lock_timeout = '5s'`
  yield* sql`ALTER TABLE sessions ADD COLUMN role_verified_at timestamptz`
  yield* sql`RESET lock_timeout`
})
