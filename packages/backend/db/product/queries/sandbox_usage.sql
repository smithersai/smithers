-- Product queries extracted from the transitional Plue source.

-- name: OpenSandboxUsageInterval :exec
INSERT INTO sandbox_usage_intervals (user_id, sandbox_kind, sandbox_id)
SELECT sqlc.arg(user_id)::bigint, sqlc.arg(sandbox_kind)::text, sqlc.arg(sandbox_id)::text
WHERE NOT EXISTS (
    SELECT 1 FROM sandbox_usage_intervals
    WHERE sandbox_kind = sqlc.arg(sandbox_kind)::text
      AND sandbox_id = sqlc.arg(sandbox_id)::text AND ended_at IS NULL
)
ON CONFLICT (sandbox_kind, sandbox_id) WHERE ended_at IS NULL DO NOTHING;


-- name: CloseSandboxUsageInterval :exec
UPDATE sandbox_usage_intervals
SET ended_at = GREATEST(started_at, now())
WHERE sandbox_kind = $1 AND sandbox_id = $2 AND ended_at IS NULL;


-- name: SumSandboxAwakeSecondsForUserSinceRaw :one
SELECT COALESCE(FLOOR(SUM(EXTRACT(EPOCH FROM
    LEAST(COALESCE(ended_at, now()), now()) - GREATEST(started_at, sqlc.arg(since)::timestamptz)
))), 0)::bigint AS seconds
FROM sandbox_usage_intervals
WHERE user_id = sqlc.arg(user_id)
  AND started_at < now()
  AND LEAST(COALESCE(ended_at, now()), now()) > GREATEST(started_at, sqlc.arg(since)::timestamptz);

