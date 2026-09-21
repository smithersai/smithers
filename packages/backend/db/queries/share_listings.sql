-- ---- Public sharing: workflow / connector listings + usage stats ----------
--
-- Public reads (catalog list + detail) see LIVE listings only
-- (unpublished_at IS NULL). Owner-scoped reads and the unpublish path key on
-- owner_user_id so authorization is expressed in SQL, not only in Go.

-- name: CreateShareListing :one
-- Publish. Every field comes from the validated request; the slug is derived
-- and disambiguated by the service, which retries once with a suffix if the
-- live-slug unique index rejects the first choice.
INSERT INTO share_listings (
    kind, name, slug, description, owner_user_id,
    source_repo_owner, source_repo_name, source_path, content_snapshot
)
VALUES (
    sqlc.arg(kind)::text,
    sqlc.arg(name)::text,
    sqlc.arg(slug)::text,
    sqlc.arg(description)::text,
    sqlc.arg(owner_user_id)::bigint,
    sqlc.arg(source_repo_owner)::text,
    sqlc.arg(source_repo_name)::text,
    sqlc.arg(source_path)::text,
    sqlc.arg(content_snapshot)::text
)
RETURNING *;

-- name: GetLiveShareListing :one
-- Public detail. An unpublished listing is indistinguishable from a
-- nonexistent one on the public surface.
SELECT *
FROM share_listings
WHERE id = sqlc.arg(id)::uuid
  AND unpublished_at IS NULL;

-- name: GetShareListingAnyState :one
-- Authorization read for DELETE: resolves the row whatever its state so the
-- handler can tell "not yours" (403) from "never existed" (404) and can make a
-- repeat unpublish idempotent.
SELECT *
FROM share_listings
WHERE id = sqlc.arg(id)::uuid;

-- name: ListLiveShareListings :many
-- The public catalog page. kind and q are optional; q is a caller-escaped
-- ILIKE needle matched against name, slug and description.
SELECT *
FROM share_listings
WHERE unpublished_at IS NULL
  AND (sqlc.narg(kind)::text IS NULL OR kind = sqlc.narg(kind)::text)
  AND (
      sqlc.narg(q)::text IS NULL
      OR name ILIKE '%' || sqlc.narg(q)::text || '%'
      OR slug ILIKE '%' || sqlc.narg(q)::text || '%'
      OR description ILIKE '%' || sqlc.narg(q)::text || '%'
  )
ORDER BY published_at DESC, id
LIMIT sqlc.arg(result_limit)::bigint
OFFSET sqlc.arg(result_offset)::bigint;

-- name: CountLiveShareListings :one
-- Total for the same filter, so the catalog can report an honest page count.
SELECT COUNT(*)::bigint
FROM share_listings
WHERE unpublished_at IS NULL
  AND (sqlc.narg(kind)::text IS NULL OR kind = sqlc.narg(kind)::text)
  AND (
      sqlc.narg(q)::text IS NULL
      OR name ILIKE '%' || sqlc.narg(q)::text || '%'
      OR slug ILIKE '%' || sqlc.narg(q)::text || '%'
      OR description ILIKE '%' || sqlc.narg(q)::text || '%'
  );

-- name: ListShareListingsForOwner :many
-- GET /api/share/my/listings — the caller's LIVE listings with their stats.
SELECT *
FROM share_listings
WHERE owner_user_id = sqlc.arg(owner_user_id)::bigint
  AND unpublished_at IS NULL
ORDER BY published_at DESC, id
LIMIT sqlc.arg(result_limit)::bigint
OFFSET sqlc.arg(result_offset)::bigint;

-- name: CountShareListingsForOwner :one
SELECT COUNT(*)::bigint
FROM share_listings
WHERE owner_user_id = sqlc.arg(owner_user_id)::bigint
  AND unpublished_at IS NULL;

-- name: UnpublishShareListing :one
-- Owner-only soft delete. Ownership is in the WHERE clause so a stranger's
-- DELETE cannot mutate the row even if a handler check were ever dropped.
-- Already-unpublished rows do not match; the caller treats that as success.
UPDATE share_listings
SET unpublished_at = NOW(),
    updated_at     = NOW()
WHERE id = sqlc.arg(id)::uuid
  AND owner_user_id = sqlc.arg(owner_user_id)::bigint
  AND unpublished_at IS NULL
RETURNING *;

-- name: RecordShareListingEvent :one
-- One install/run ping against a live listing, in a single round trip:
--
--   target    the live listing, or nothing (caller answers 404).
--   accepted  atomically inserts or advances the caller's durable cooldown
--             row only when the prior count is old enough. The composite key
--             serializes concurrent pings for the same (listing, user, type),
--             so a client loop is accepted (202) but counted once per window.
--   bumped    the denormalized tally, incremented only when accepted has a row.
--
-- Data-modifying CTEs run exactly once and to completion regardless of whether
-- the outer SELECT reads them, so the EXISTS probes below are safe.
WITH input AS (
    SELECT
        sqlc.arg(listing_id)::uuid AS listing_id,
        sqlc.arg(user_id)::bigint AS user_id,
        sqlc.arg(event_type)::text AS event_type,
        sqlc.arg(counted_at)::timestamptz AS counted_at,
        sqlc.arg(dedupe_cutoff)::timestamptz AS dedupe_cutoff
),
target AS (
    SELECT l.id
    FROM share_listings l
    JOIN input i ON i.listing_id = l.id
    WHERE l.unpublished_at IS NULL
),
accepted AS (
    INSERT INTO share_listing_event_cooldowns (
        listing_id, user_id, event_type, last_counted_at
    )
    SELECT t.id, i.user_id, i.event_type, i.counted_at
    FROM target t
    CROSS JOIN input i
    ON CONFLICT (listing_id, user_id, event_type) DO UPDATE
    SET last_counted_at = EXCLUDED.last_counted_at
    WHERE share_listing_event_cooldowns.last_counted_at <=
          (SELECT dedupe_cutoff FROM input)
    RETURNING listing_id, event_type
),
bumped AS (
    UPDATE share_listings l
    SET install_count = l.install_count + CASE WHEN accepted.event_type = 'install' THEN 1 ELSE 0 END,
        use_count     = l.use_count + CASE WHEN accepted.event_type = 'run' THEN 1 ELSE 0 END,
        updated_at    = NOW()
    FROM accepted
    WHERE l.id = accepted.listing_id
    RETURNING l.install_count, l.use_count
)
SELECT
    EXISTS (SELECT 1 FROM target) AS listing_found,
    EXISTS (SELECT 1 FROM accepted) AS counted,
    COALESCE(
        (SELECT b.install_count FROM bumped b),
        (SELECT l.install_count FROM share_listings l JOIN input i ON i.listing_id = l.id),
        0
    )::bigint AS install_count,
    COALESCE(
        (SELECT b.use_count FROM bumped b),
        (SELECT l.use_count FROM share_listings l JOIN input i ON i.listing_id = l.id),
        0
    )::bigint AS use_count;
