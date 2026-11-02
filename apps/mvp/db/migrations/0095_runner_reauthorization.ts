import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Every runner is registered again (decision 0148, docs/features/agent-runners.md#registering-a-runner-again).
//
// - `runners.repo_authorized_at` is cleared on every row. Migration 0089 marked a runner authorized where its
//   repository's installation record was older than its registration, which proves nothing: before 2026-11-02 the
//   Admin route's role fell back to the deployment's Admin role wherever GitHub gave none on the repository
//   (`not_found`), a repository outside GITHUB_ALLOWED_REPOSITORIES included. Only a registration through the route that
//   takes the Admin role GitHub gives on the repository marks a runner authorized again; until then it claims nothing.
// - `agent_jobs.git_credential_reservation`, `git_credential_reserved_at`: the one mint in flight for a job's runner,
//   which only that request finalizes or releases. `git_credential_retry_at`: the soonest the next mint may start after
//   one failed, GitHub's own wait included.
// - `agent_jobs.stopped_claim`: the claim of a job the host ended for a Stop while it refused the job's runner; that
//   runner's heartbeats for the same key and claim keep hearing `cancel`, so an answer lost on the way is said again.
// - `agent_jobs.claimed_token_sha256`: the SHA-256 of the token that claimed or last reclaimed the job, so a runner whose
//   token was since rotated or retired still hears a Stop on that job's heartbeat, and nothing else.

/**
 * How long the migration waits for a lock: a deploy that meets a long transaction on `runners` or `agent_jobs` fails
 * now and runs again, rather than queueing the runner routes behind the lock it waits for.
 */
export const LOCK_TIMEOUT = "5s"

/** The longest one of the migration's statements runs. */
export const STATEMENT_TIMEOUT = "60s"

/** Clears every runner's authorization (above): each claims nothing until an Admin registers it again. */
export const clearAuthorization = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql`UPDATE runners SET repo_authorized_at = NULL WHERE repo_authorized_at IS NOT NULL`)

/**
 * Each job claimed before this migration gets its runner's token's SHA-256 now, the runners' rows locked first, so a
 * runner rotated or retired after the deploy still hears a Stop on a job it held across it.
 */
export const backfillClaimedTokens = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql`
    UPDATE agent_jobs j SET claimed_token_sha256 = r.token_sha256
    FROM (SELECT id, token_sha256 FROM runners FOR SHARE) r
    WHERE j.runner_id = r.id AND j.status = 'claimed' AND j.claimed_token_sha256 IS NULL`)

/**
 * The migration's work under `LOCK_TIMEOUT` and `STATEMENT_TIMEOUT`, set for the migrations' one transaction and put
 * back after, so the migrations after it run as they would have.
 */
export const migration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [before] = yield* sql<{ readonly lock: string; readonly statement: string }>`
    SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement`
  yield* sql`SELECT set_config('lock_timeout', ${LOCK_TIMEOUT}, true), set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true)`
  yield* clearAuthorization
  yield* sql`
    ALTER TABLE agent_jobs
      ADD COLUMN IF NOT EXISTS git_credential_reservation uuid,
      ADD COLUMN IF NOT EXISTS git_credential_reserved_at timestamptz,
      ADD COLUMN IF NOT EXISTS git_credential_retry_at timestamptz,
      ADD COLUMN IF NOT EXISTS stopped_claim uuid,
      ADD COLUMN IF NOT EXISTS claimed_token_sha256 text`
  yield* backfillClaimedTokens
  yield* sql`SELECT set_config('lock_timeout', ${before!.lock}, true), set_config('statement_timeout', ${before!.statement}, true)`
})

export default migration
