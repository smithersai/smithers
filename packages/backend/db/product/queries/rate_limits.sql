-- name: ConsumeSearchRateLimitToken :one
WITH input AS (
    SELECT
        sqlc.arg(scope)::text AS scope,
        sqlc.arg(principal_key)::text AS principal_key,
        sqlc.arg(capacity)::double precision AS capacity,
        sqlc.arg(refill_per_second)::double precision AS refill_per_second,
        sqlc.arg(now_at)::timestamptz AS now_at
),
inserted AS (
    INSERT INTO search_rate_limits (scope, principal_key, tokens, last_refill_at, created_at, updated_at)
    SELECT
        i.scope,
        i.principal_key,
        CASE
            WHEN i.capacity >= 1 THEN i.capacity - 1
            ELSE i.capacity
        END,
        i.now_at,
        i.now_at,
        i.now_at
    FROM input i
    ON CONFLICT (scope, principal_key) DO NOTHING
    RETURNING
        scope,
        principal_key,
        tokens
),
existing AS (
    SELECT
        rl.scope,
        rl.principal_key,
        rl.tokens,
        rl.last_refill_at,
        i.capacity,
        i.refill_per_second,
        i.now_at
    FROM search_rate_limits rl
    JOIN input i ON i.scope = rl.scope AND i.principal_key = rl.principal_key
    WHERE NOT EXISTS (SELECT 1 FROM inserted)
    FOR UPDATE
),
computed_existing AS (
    SELECT
        e.scope,
        e.principal_key,
        e.now_at,
        LEAST(
            e.capacity,
            e.tokens + EXTRACT(EPOCH FROM (e.now_at - e.last_refill_at)) * e.refill_per_second
        ) AS available_tokens
    FROM existing e
),
updated_existing AS (
    UPDATE search_rate_limits rl
    SET tokens = CASE
            WHEN c.available_tokens >= 1 THEN c.available_tokens - 1
            ELSE c.available_tokens
        END,
        last_refill_at = c.now_at,
        updated_at = c.now_at
    FROM computed_existing c
    WHERE rl.scope = c.scope
      AND rl.principal_key = c.principal_key
    RETURNING
        c.available_tokens >= 1 AS allowed,
        (
            CASE
            WHEN c.available_tokens >= 1 THEN c.available_tokens - 1
            ELSE c.available_tokens
            END
        )::double precision AS remaining_tokens,
        c.now_at
),
inserted_result AS (
    SELECT
        i.capacity >= 1 AS allowed,
        ins.tokens::double precision AS remaining_tokens,
        i.now_at
    FROM inserted ins
    JOIN input i ON i.scope = ins.scope AND i.principal_key = ins.principal_key
)
SELECT
    r.allowed,
    r.remaining_tokens,
    r.now_at
FROM updated_existing r
UNION ALL
SELECT
    r.allowed,
    r.remaining_tokens,
    r.now_at
FROM inserted_result r;

-- name: DeleteExpiredSearchRateLimits :exec
DELETE FROM search_rate_limits
WHERE updated_at < sqlc.arg(cutoff_at)::timestamptz;

-- name: DeleteAllRateLimits :exec
DELETE FROM search_rate_limits;
