-- name: GetRepositorySourcePushEvent :one
SELECT payload FROM repository_job_events
WHERE repository_id = $1 AND delivery_key = $2
  AND source = 'github' AND event_type = 'push';
