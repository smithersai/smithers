-- Revision: 20260802120000.
-- Continuously-synced GitHub mirror registry + metadata store.
--
-- Replaces the live-passthrough GitHub metadata proxy (one GitHub call per
-- request) and the single static github-sync mapping with a dynamic registry:
--
--   github_synced_repos          one row per enrolled github owner/repo. Rows
--                                are created on import, on a SmithersPreviewRelease
--                                installation webhook, or lazily on the first
--                                metadata read for a repo the app can see.
--                                sync_refs / sync_metadata say WHICH kinds of
--                                sync are on; ref mirroring defaults to on.
--   github_synced_issues         last-good issue AND pull-request objects
--                                (GitHub's raw JSON in `payload`), backfilled
--                                on enroll and kept fresh by the issues /
--                                pull_request webhooks.
--   github_synced_issue_comments last-good comment objects, kept fresh by the
--                                issue_comment webhook.
--
-- Freshness semantics mirror github_repo_listings (stale-while-revalidate):
--   last_synced_at   when the store was last reconciled against GitHub.
--   last_webhook_at  heartbeat proving webhooks are actually arriving; a repo
--                    with a recent heartbeat is fresh without any polling.
--   syncing_since    singleflight claim on a backfill/revalidate.
--   sync_error       last failure. NEVER wipes the last-good payload — the
--                    proxy serves last-good with an honest staleness header.

CREATE TABLE IF NOT EXISTS github_synced_repos (
    id                BIGSERIAL PRIMARY KEY,
    owner_login       VARCHAR(255) NOT NULL CHECK (LENGTH(owner_login) BETWEEN 1 AND 255),
    owner_login_lower VARCHAR(255) NOT NULL,
    repo_name         VARCHAR(255) NOT NULL CHECK (LENGTH(repo_name) BETWEEN 1 AND 255),
    repo_name_lower   VARCHAR(255) NOT NULL,
    installation_id   BIGINT,
    sync_refs         BOOLEAN NOT NULL DEFAULT TRUE,
    sync_metadata     BOOLEAN NOT NULL DEFAULT TRUE,
    sync_state        VARCHAR(16) NOT NULL DEFAULT 'pending'
                      CHECK (sync_state IN ('pending', 'syncing', 'ready', 'error', 'disabled')),
    enrolled_via      VARCHAR(16) NOT NULL DEFAULT 'lazy'
                      CHECK (enrolled_via IN ('import', 'installation', 'lazy')),
    -- The jjhub-side mirror this GitHub repo is mirrored into, when one exists.
    -- Nullable: metadata-only enrollments never create a mirror.
    mirror_owner      VARCHAR(255),
    mirror_repo       VARCHAR(255),
    last_synced_at    TIMESTAMPTZ,
    last_webhook_at   TIMESTAMPTZ,
    syncing_since     TIMESTAMPTZ,
    sync_error        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- GitHub owner/repo names are case-insensitive; the registry is keyed on the
-- folded slug so "Octocat/Hello" and "octocat/hello" are one enrollment.
CREATE UNIQUE INDEX IF NOT EXISTS uq_github_synced_repos_slug
    ON github_synced_repos (owner_login_lower, repo_name_lower);

-- The github-sync registry feed (ref mirroring) and the installation fan-out.
CREATE INDEX IF NOT EXISTS idx_github_synced_repos_refs
    ON github_synced_repos (owner_login_lower, repo_name_lower)
    WHERE sync_refs AND sync_state <> 'disabled';

CREATE INDEX IF NOT EXISTS idx_github_synced_repos_installation
    ON github_synced_repos (installation_id)
    WHERE installation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS github_synced_issues (
    id                BIGSERIAL PRIMARY KEY,
    synced_repo_id    BIGINT NOT NULL REFERENCES github_synced_repos(id) ON DELETE CASCADE,
    -- 'issues' or 'pulls' — the same resource names the proxy routes use. A
    -- pull request is also an issue on GitHub, but the two collections page
    -- and sort differently, so they are stored as distinct rows.
    resource          VARCHAR(16) NOT NULL CHECK (resource IN ('issues', 'pulls')),
    number            BIGINT NOT NULL CHECK (number > 0),
    github_id         BIGINT NOT NULL,
    state             VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
    title             TEXT NOT NULL DEFAULT '',
    -- GitHub's raw object, served back to clients byte-for-byte so the proxy
    -- never has to model GitHub's issue/PR schema (same contract as the live
    -- passthrough's GitHubRepoMetadataResult.Body).
    payload           JSONB NOT NULL,
    github_created_at TIMESTAMPTZ,
    github_updated_at TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_github_synced_issues_number
    ON github_synced_issues (synced_repo_id, resource, number);

-- The proxy's read shapes: one repo + resource, filtered by state, ordered
-- created-desc (GitHub's default for both collections) or updated-desc
-- (sort=updated).
CREATE INDEX IF NOT EXISTS idx_github_synced_issues_listing
    ON github_synced_issues (synced_repo_id, resource, state, github_updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_github_synced_issues_listing_created
    ON github_synced_issues (synced_repo_id, resource, state, github_created_at DESC);

CREATE TABLE IF NOT EXISTS github_synced_issue_comments (
    id                BIGSERIAL PRIMARY KEY,
    synced_repo_id    BIGINT NOT NULL REFERENCES github_synced_repos(id) ON DELETE CASCADE,
    issue_number      BIGINT NOT NULL CHECK (issue_number > 0),
    github_id         BIGINT NOT NULL,
    payload           JSONB NOT NULL,
    github_created_at TIMESTAMPTZ,
    github_updated_at TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_github_synced_issue_comments_github_id
    ON github_synced_issue_comments (synced_repo_id, github_id);

CREATE INDEX IF NOT EXISTS idx_github_synced_issue_comments_issue
    ON github_synced_issue_comments (synced_repo_id, issue_number, github_created_at);
