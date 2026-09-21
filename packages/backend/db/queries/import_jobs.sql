-- name: GetReadyImportedRepoForUserBySource :one
-- Resolves a repository through the requesting user's own completed GitHub
-- import: mirrors live under the importing user's namespace (repo_context
-- resolves "alice/repo"), but clients routinely address them by the GitHub
-- SOURCE coordinates they picked ("octocat/repo"). Scoped to ij.user_id so one
-- user's provenance never resolves for another; newest ready job wins so a
-- re-import points at the current mirror.
SELECT sqlc.embed(r), COALESCE(u.lower_username, o.lower_name) AS local_owner
FROM import_jobs ij
JOIN repositories r ON r.id = ij.repository_id
LEFT JOIN users u ON u.id = r.user_id
LEFT JOIN organizations o ON o.id = r.org_id
WHERE ij.user_id = sqlc.arg(user_id)
  AND lower(ij.github_owner) = sqlc.arg(github_owner)
  AND lower(ij.github_repo) = sqlc.arg(github_repo)
  AND ij.status = 'ready'
  AND COALESCE(u.lower_username, o.lower_name) IS NOT NULL
ORDER BY ij.created_at DESC
LIMIT 1;
