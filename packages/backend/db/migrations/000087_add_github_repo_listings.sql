-- GitHub repo listing cache: one row per user holding the user's merged
-- GET /user/repos listing (canonical shape: sort=pushed, per_page=100 pages
-- concatenated), served stale-while-revalidate by GET /api/user/github-repos.
--
-- Semantics:
--   payload        last-good listing (JSON array of repo objects). NEVER
--                  wiped on refresh failure — failures only record sync_error.
--   synced_at      when payload was last refreshed from GitHub.
--   sync_error     last background refresh failure (cleared on success).
--   syncing_since  singleflight claim: a refresh has been in flight since this
--                  time; claims older than the takeover window (2 minutes) are
--                  considered abandoned and may be re-claimed.
CREATE TABLE IF NOT EXISTS github_repo_listings (
    user_id       BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    payload       JSONB NOT NULL DEFAULT '[]'::jsonb,
    synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sync_error    TEXT,
    syncing_since TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
