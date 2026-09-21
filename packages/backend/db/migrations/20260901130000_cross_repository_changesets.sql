-- Cross-repository changesets: one organization superproject commit pins a
-- vector of member-repository revisions. The superproject itself is an
-- ordinary org repository row on repo-host (reserved name `superproject`);
-- these tables are the control-plane record of each changeset and its
-- transactional landing outcome. Additive only: two new tables, no backfill.
-- smithers:migration-contract-reviewed: additive tables only, no data movement
CREATE TABLE IF NOT EXISTS changesets (
    id                 BIGSERIAL PRIMARY KEY,
    organization_id    BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    superproject_repository_id BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    change_id          VARCHAR(255) NOT NULL,
    commit_id          VARCHAR(255) NOT NULL,
    parent_change_ids  JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(parent_change_ids) = 'array'),
    target_bookmark    VARCHAR(255) NOT NULL DEFAULT 'main',
    description        TEXT NOT NULL DEFAULT '',
    state              VARCHAR(16) NOT NULL DEFAULT 'pending'
                       CHECK (state IN ('pending', 'landing', 'landed', 'failed')),
    failure_reason     TEXT NOT NULL DEFAULT '',
    landed_commit_id   VARCHAR(255) NOT NULL DEFAULT '',
    created_by         BIGINT REFERENCES users(id) ON DELETE SET NULL,
    landed_at          TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, change_id)
);

CREATE INDEX IF NOT EXISTS idx_changesets_org_created ON changesets (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_changesets_org_state ON changesets (organization_id, state);

CREATE TABLE IF NOT EXISTS changeset_members (
    id                 BIGSERIAL PRIMARY KEY,
    changeset_id       BIGINT NOT NULL REFERENCES changesets(id) ON DELETE CASCADE,
    repository_id      BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    path               VARCHAR(255) NOT NULL,
    change_id          VARCHAR(255) NOT NULL,
    commit_id          VARCHAR(255) NOT NULL,
    target_bookmark    VARCHAR(255) NOT NULL DEFAULT 'main',
    previous_commit_id VARCHAR(255) NOT NULL DEFAULT '',
    landed_commit_id   VARCHAR(255) NOT NULL DEFAULT '',
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (changeset_id, repository_id),
    UNIQUE (changeset_id, path)
);

CREATE INDEX IF NOT EXISTS idx_changeset_members_repository ON changeset_members (repository_id);
