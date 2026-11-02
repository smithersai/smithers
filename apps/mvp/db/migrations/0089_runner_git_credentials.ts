import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// A runner's git credential (decision 0148, docs/features/agent-runners.md#private-repositories).
//
// - `runners.repo_authorized_at`: when an Admin of the repository, by the role GitHub gives there, registered the
//   runner. Only such a runner claims a job or is handed a credential. Before 2026-11-02 the route that registered a
//   runner took the deployment-wide role where Smithers had recorded no installation; where one was recorded, it took
//   the role GitHub gave there. So a row is backfilled (`backfill`) only where its repository's recorded installation
//   is older than the registration: `github_repositories` keeps no time the installation was recorded, and
//   `checked_at`, which every write of the row sets, is the best there is. A row written after the runner was added
//   (the installation recorded, forgotten or recorded again since) proves nothing, and stays null until an Admin
//   registers the runner again.
// - `agent_jobs.git_credentials`, `git_credentials_since`, `git_credential_at`: how many credentials the job's runner
//   was handed in the hour since the first, and when the last, so the route bounds issuance per job.
/** Marks authorized each runner registered after its repository's installation was last recorded (above). */
export const backfill = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql`
    UPDATE runners r SET repo_authorized_at = r.added_at
    FROM github_repositories g
    WHERE g.repo_id = r.repo_id AND g.installation_id IS NOT NULL AND g.checked_at <= r.added_at
      AND r.repo_authorized_at IS NULL`)

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE runners ADD COLUMN repo_authorized_at timestamptz`
  yield* sql`
    ALTER TABLE agent_jobs
      ADD COLUMN git_credentials integer NOT NULL DEFAULT 0 CHECK (git_credentials >= 0),
      ADD COLUMN git_credentials_since timestamptz,
      ADD COLUMN git_credential_at timestamptz`
  yield* backfill
})
