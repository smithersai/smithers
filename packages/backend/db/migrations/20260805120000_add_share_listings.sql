-- Revision: 20260805120000.
-- Selective public sharing of workflows and connectors, with usage stats.
--
-- Publishing is ALWAYS an explicit act: nothing lands in share_listings unless
-- the owner posted it. A listing carries the DEFINITION only — the flow or
-- connector manifest text captured at publish time (content_snapshot) — never
-- credentials. Consumers supply their own connector credentials through their
-- own setup flow and secret store; the publish path rejects snapshots that
-- carry obvious credential material (internal/services/share_listing_secret_scan.go).
--
--   share_listings        one row per published workflow/connector. Unpublish is
--                         a soft delete (unpublished_at): the row leaves the
--                         public catalog immediately, while the counters and
--                         event history stay intact for the owner's stats.
--                         Copies already installed by consumers are THEIR
--                         copies and are unaffected — unpublishing is not a
--                         recall.
--   share_listing_event_cooldowns  the last counted install/run per
--                         (listing, user, type). Its composite primary key makes
--                         cooldown enforcement atomic under concurrent pings.
--                         The counters on share_listings are the denormalized
--                         tallies so catalog reads never aggregate.
--
-- Abuse resistance is two-layered: a durable per-user token bucket in front of
-- the events route (middleware.ShareListingEventRateLimit) plus a per
-- (listing, user, type) cooldown enforced inside RecordShareListingEvent, so a
-- tight client loop cannot inflate a listing's numbers.

CREATE TABLE IF NOT EXISTS share_listings (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind              VARCHAR(16) NOT NULL CHECK (kind IN ('workflow', 'connector')),
    name              VARCHAR(128) NOT NULL CHECK (LENGTH(name) BETWEEN 1 AND 128),
    -- URL-safe handle derived from the name at publish time. Unique among LIVE
    -- listings of the same kind; a collision gets a short disambiguating suffix.
    slug              VARCHAR(160) NOT NULL CHECK (LENGTH(slug) BETWEEN 1 AND 160),
    description       TEXT NOT NULL DEFAULT '',
    owner_user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_repo_owner VARCHAR(255) NOT NULL,
    source_repo_name  VARCHAR(255) NOT NULL,
    source_path       TEXT NOT NULL,
    -- The flow/manifest file text as it read at publish time. Immutable: a
    -- listing is a snapshot, not a live pointer at a moving branch.
    content_snapshot  TEXT NOT NULL,
    use_count         BIGINT NOT NULL DEFAULT 0 CHECK (use_count >= 0),
    install_count     BIGINT NOT NULL DEFAULT 0 CHECK (install_count >= 0),
    published_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    unpublished_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_share_listings_live_slug
    ON share_listings (kind, slug)
    WHERE unpublished_at IS NULL;

-- The public catalog read: newest first, optionally filtered by kind.
CREATE INDEX IF NOT EXISTS idx_share_listings_catalog
    ON share_listings (kind, published_at DESC)
    WHERE unpublished_at IS NULL;

-- GET /api/share/my/listings.
CREATE INDEX IF NOT EXISTS idx_share_listings_owner
    ON share_listings (owner_user_id, published_at DESC);

CREATE TABLE IF NOT EXISTS share_listing_event_cooldowns (
    listing_id      UUID NOT NULL REFERENCES share_listings(id) ON DELETE CASCADE,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_type      VARCHAR(16) NOT NULL CHECK (event_type IN ('install', 'run')),
    last_counted_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (listing_id, user_id, event_type)
);
