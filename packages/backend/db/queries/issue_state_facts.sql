-- name: GetIssueStateJournal :one
SELECT * FROM issue_state_journals WHERE repository_id = $1;

-- name: ListIssueStateFacts :many
SELECT * FROM issue_state_facts
WHERE repository_id = sqlc.arg(repository_id)
  AND sequence > sqlc.arg(after_sequence)
  AND sequence <= sqlc.arg(through_sequence)
ORDER BY sequence ASC
LIMIT sqlc.arg(page_size);
