import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// A request's look at a person's role row on a repository (worker/github/RepoRoles.ts `readState`) in one statement and
// one round trip, bounded by Postgres itself: the function's own `lock_timeout` ends a wait for the table's lock (an
// ACCESS EXCLUSIVE one, a migration's, is the only lock a plain read waits behind), whatever the client's cancellation
// does. Before, the look was a transaction of four round trips (BEGIN, set_config, SELECT, COMMIT) that held a pooled
// connection for all four; production's Hyperdrive pool ran out under that load on 2026-11-02. A SQL function with a SET
// clause is never inlined, so its query runs, and takes its lock, under the function's settings.
//
// VOLATILE, not STABLE: a VOLATILE function's query takes its own snapshot, after any wait for the table's lock, so it
// sees a role the lock's holder committed. A STABLE one reads under its caller's snapshot from before the wait, and a
// role taken away came back as the old one, fresh. The function and its table are named in the schema it is created in,
// and its own `search_path` holds only pg_catalog and, last, pg_temp, so no object a session's search_path puts first
// stands in for them.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    DO $do$ BEGIN EXECUTE format($create$
      CREATE FUNCTION %1$I.github_repo_role_state(repo text, person text, after timestamptz, fresh_seconds double precision)
      RETURNS TABLE (
        role text, checked_at text, fresh boolean, claimed boolean, failed boolean, refusal text, remaining_seconds double precision
      )
      LANGUAGE sql VOLATILE
      SET lock_timeout = '1s'
      SET search_path = pg_catalog, pg_temp
      AS $fn$
        SELECT r.role, r.checked_at::text,
          r.checked_at > clock_timestamp() - make_interval(secs => fresh_seconds)
            AND (after IS NULL OR r.checked_at > after),
          coalesce(r.read_until > clock_timestamp(), false), r.read_failed, r.read_refusal,
          EXTRACT(EPOCH FROM r.read_until - clock_timestamp())::float8
        FROM %1$I.github_repo_roles r WHERE r.repo_id = repo AND r.person_id = person
      $fn$
    $create$, current_schema()); END $do$`
})
