-- Product queries extracted from the transitional Plue source.

-- name: GetLandingQueueDepth :one
-- Landing work still waiting for a worker. Retries whose backoff has not
-- elapsed are queued work too, so this counts every pending task rather than
-- mirroring ClaimPendingLandingTask's available_at gate.
SELECT COUNT(*)::bigint AS depth
FROM landing_tasks
WHERE status IN ('pending', 'append_pending');

