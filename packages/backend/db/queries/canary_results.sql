-- name: ListCanaryResults :many
SELECT id, suite, test_name, status, duration_seconds, error_message, run_id, reported_at, created_at, updated_at
FROM canary_results
ORDER BY suite ASC, test_name ASC;

-- name: UpsertCanaryResult :one
INSERT INTO canary_results (
    suite,
    test_name,
    status,
    duration_seconds,
    error_message,
    run_id,
    reported_at
)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (suite, test_name)
DO UPDATE SET
    status = EXCLUDED.status,
    duration_seconds = EXCLUDED.duration_seconds,
    error_message = EXCLUDED.error_message,
    run_id = EXCLUDED.run_id,
    reported_at = EXCLUDED.reported_at,
    updated_at = NOW()
RETURNING *;
