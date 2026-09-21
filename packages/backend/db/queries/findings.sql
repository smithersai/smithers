-- name: UpsertAnalyzerRun :one
INSERT INTO analyzer_runs (
    repository_id,
    change_id,
    revision_seq,
    name,
    state,
    started_at,
    finished_at,
    paused_by,
    paused_reason,
    failure_reason
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (repository_id, change_id, revision_seq, name)
DO UPDATE SET
    state = EXCLUDED.state,
    started_at = EXCLUDED.started_at,
    finished_at = EXCLUDED.finished_at,
    paused_by = EXCLUDED.paused_by,
    paused_reason = EXCLUDED.paused_reason,
    failure_reason = EXCLUDED.failure_reason,
    updated_at = NOW()
RETURNING *;

-- name: ListAnalyzerRunsForChange :many
SELECT *
FROM analyzer_runs
WHERE repository_id = sqlc.arg(repository_id)
  AND change_id = sqlc.arg(change_id)
  AND (sqlc.narg(revision_seq)::bigint IS NULL OR revision_seq = sqlc.narg(revision_seq))
ORDER BY revision_seq ASC, name ASC;

-- name: CreateFinding :one
INSERT INTO findings (
    repository_id,
    change_id,
    revision_seq,
    analyzer,
    source,
    path,
    line,
    side,
    severity,
    text,
    suggestion,
    anchor_hash,
    feedback
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
RETURNING *;

-- name: ListFindingsForChange :many
SELECT *
FROM findings
WHERE repository_id = sqlc.arg(repository_id)
  AND change_id = sqlc.arg(change_id)
  AND (sqlc.narg(revision_seq)::bigint IS NULL OR revision_seq = sqlc.narg(revision_seq))
ORDER BY revision_seq ASC, analyzer ASC, id ASC;

-- name: ListFindingFeedbackForChange :many
SELECT
    f.id AS finding_id,
    caller.useful AS caller_useful,
    caller.note AS caller_note,
    caller.user_id AS caller_user_id,
    COUNT(all_feedback.user_id) FILTER (WHERE all_feedback.useful) AS useful_count,
    COUNT(all_feedback.user_id) FILTER (WHERE NOT all_feedback.useful) AS not_useful_count
FROM findings AS f
LEFT JOIN finding_feedback AS caller
  ON caller.finding_id = f.id
 AND caller.user_id = sqlc.narg(user_id)::bigint
LEFT JOIN finding_feedback AS all_feedback
  ON all_feedback.finding_id = f.id
WHERE f.repository_id = sqlc.arg(repository_id)
  AND f.change_id = sqlc.arg(change_id)
  AND (sqlc.narg(revision_seq)::bigint IS NULL OR f.revision_seq = sqlc.narg(revision_seq))
GROUP BY f.id, caller.useful, caller.note, caller.user_id
ORDER BY f.id ASC;

-- name: GetFindingForChange :one
SELECT *
FROM findings
WHERE id = sqlc.arg(id)
  AND repository_id = sqlc.arg(repository_id)
  AND change_id = sqlc.arg(change_id);

-- name: UpsertFindingFeedback :one
INSERT INTO finding_feedback (finding_id, user_id, useful, note)
VALUES (sqlc.arg(finding_id), sqlc.arg(user_id), sqlc.arg(useful), sqlc.narg(note))
ON CONFLICT (finding_id, user_id)
DO UPDATE SET
    useful = EXCLUDED.useful,
    note = EXCLUDED.note
RETURNING *;

-- name: GetWorkspaceBookmarkForChange :one
SELECT target_bookmark
FROM workspaces
WHERE repository_id = sqlc.arg(repository_id)
  AND user_id = sqlc.arg(user_id)
  AND head_change_id = sqlc.arg(change_id)
  AND kind <> 'agent'
  AND deleted_at IS NULL
ORDER BY (status = 'running') DESC, last_activity_at DESC NULLS LAST, created_at DESC
LIMIT 1;

-- name: GetActiveFindingDispatch :one
SELECT *
FROM agent_sessions
WHERE repository_id = sqlc.arg(repository_id)
  AND status = 'active'
  AND deleted_at IS NULL
  AND metadata ->> 'finding_id' = sqlc.arg(finding_id)::bigint::text
LIMIT 1;

-- name: UpdateFindingFeedback :one
UPDATE findings
SET feedback = sqlc.arg(feedback), updated_at = NOW()
WHERE id = sqlc.arg(id)
  AND repository_id = sqlc.arg(repository_id)
  AND change_id = sqlc.arg(change_id)
RETURNING *;
