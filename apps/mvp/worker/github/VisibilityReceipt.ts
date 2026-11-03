import { Effect } from "effect"
import { SqlClient } from "effect/sql"

/** Database time at the start of a metadata observation, before any network request. */
export const repositoryObservation = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ readonly at: string }>`SELECT clock_timestamp()::text AS at`
  return row!.at
})

/**
 * Records metadata at the database observation time captured before its request. Every visibility writer shares this
 * ordered upsert: a delayed response cannot refresh or replace a newer receipt. Returns the accepted receipt, if any.
 */
export const recordRepository = (
  repoId: string,
  repository: { readonly githubId?: number; readonly private: boolean },
  observedAt: string,
) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [recorded] = yield* sql<{ readonly public: boolean; readonly fresh: boolean }>`
    INSERT INTO github_repositories (repo_id, github_id, private, visibility_verified_at)
    VALUES (${repoId}, ${repository.githubId ?? null}, ${repository.private}, ${observedAt}::timestamptz)
    ON CONFLICT (repo_id) DO UPDATE SET github_id = COALESCE(EXCLUDED.github_id, github_repositories.github_id),
      private = EXCLUDED.private, checked_at = now(), visibility_verified_at = EXCLUDED.visibility_verified_at
    WHERE github_repositories.visibility_verified_at IS NULL
      OR github_repositories.visibility_verified_at < EXCLUDED.visibility_verified_at
    RETURNING private = false AS public,
      visibility_verified_at > clock_timestamp() - interval '60 seconds'
        AND visibility_verified_at <= clock_timestamp() AS fresh`
  return recorded
})

