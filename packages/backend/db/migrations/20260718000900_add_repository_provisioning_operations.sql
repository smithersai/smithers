-- Revision: 20260718000900.
-- Repository creation crosses PostgreSQL and repo-host. Keep the repository
-- row invisible until token-owned storage is staged and atomically published,
-- while retaining enough identity to resume after an API process stop.

-- Expand/contract rollout control. The migration must coexist with old API
-- pods that still perform unjournaled INSERTs. Compatibility mode permits only
-- an insert with no provisioning token and no exact/namespace reservation;
-- every token-bound or active operation is fenced immediately. After all old
-- pods are drained, contract with:
--
--   UPDATE repository_provisioning_control
--   SET enforce_insert_fence = TRUE, updated_at = NOW()
--   WHERE singleton;
--
-- Emergency rollback changes TRUE back to FALSE; it never weakens fences for
-- active operations. Phase-two production manifests enable enforcement only
-- after every legacy API pod has drained.
CREATE TABLE repository_provisioning_control (
    singleton            BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    enforce_insert_fence BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO repository_provisioning_control (singleton, enforce_insert_fence)
VALUES (TRUE, FALSE);

-- Fresh GitHub imports must bind their durable job to the invisible
-- reservation before detached/restartable work begins. The operation token is
-- retained as provenance after the short-lived provisioning row is finalized.
ALTER TABLE import_jobs
    ADD COLUMN provisioning_repository_id BIGINT,
    ADD COLUMN provisioning_token VARCHAR(64),
    ADD COLUMN claim_token VARCHAR(64),
    ADD COLUMN claimed_at TIMESTAMPTZ,
    ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD CONSTRAINT ck_import_jobs_provisioning_binding CHECK (
        (provisioning_repository_id IS NULL AND provisioning_token IS NULL)
        OR
        (provisioning_repository_id IS NOT NULL
         AND provisioning_token ~ '^[0-9a-f]{64}$')
    ),
    ADD CONSTRAINT ck_import_jobs_claim CHECK (
        (claim_token IS NULL AND claimed_at IS NULL)
        OR
        (claim_token ~ '^[0-9a-f]{64}$' AND claimed_at IS NOT NULL)
    ),
    ADD CONSTRAINT ck_import_jobs_attempts CHECK (attempts >= 0);

CREATE UNIQUE INDEX uq_import_jobs_provisioning_repository
    ON import_jobs (provisioning_repository_id)
    WHERE provisioning_repository_id IS NOT NULL;
CREATE UNIQUE INDEX uq_import_jobs_provisioning_token
    ON import_jobs (provisioning_token)
    WHERE provisioning_token IS NOT NULL;
CREATE INDEX idx_import_jobs_retryable_claim
    ON import_jobs (available_at, claimed_at, created_at, id)
    WHERE status = 'cloning';

-- Old detached imports had no active-source fence and could be stranded in
-- cloning after a process stop. Keep the oldest deterministic claimant and
-- terminalize extras before installing the unique index so rollout never
-- fails on plausible legacy state.
WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY user_id, LOWER(github_owner), LOWER(github_repo)
               ORDER BY created_at, id
           ) AS position
    FROM import_jobs
    WHERE status = 'cloning'
)
UPDATE import_jobs AS job
SET status = 'failed',
    error = 'superseded by durable active-source import deduplication',
    updated_at = NOW()
FROM ranked
WHERE ranked.id = job.id
  AND ranked.position > 1;

CREATE UNIQUE INDEX uq_import_jobs_one_active_source
    ON import_jobs (user_id, LOWER(github_owner), LOWER(github_repo))
    WHERE status = 'cloning';

CREATE TABLE repository_provisioning_operations (
    repository_id       BIGINT PRIMARY KEY,
    operation_type      VARCHAR(16) NOT NULL
                        CHECK (operation_type IN ('init', 'fork', 'import')),
    token               VARCHAR(64) NOT NULL UNIQUE
                        CHECK (token ~ '^[0-9a-f]{64}$'),
    actor_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    storage_set_id      TEXT NOT NULL REFERENCES repo_storage_sets(id),
    owner_name          VARCHAR(255) NOT NULL,
    user_id             BIGINT REFERENCES users(id),
    org_id              BIGINT REFERENCES organizations(id),
    name                VARCHAR(255) NOT NULL,
    lower_name          VARCHAR(255) NOT NULL,
    description         TEXT NOT NULL DEFAULT '',
    is_public           BOOLEAN NOT NULL,
    default_bookmark    VARCHAR(255) NOT NULL,
    auto_init           BOOLEAN NOT NULL DEFAULT FALSE,
    is_fork             BOOLEAN NOT NULL DEFAULT FALSE,
    fork_id             BIGINT REFERENCES repositories(id) ON DELETE RESTRICT,
    source_repository_id BIGINT REFERENCES repositories(id) ON DELETE RESTRICT,
    source_owner        VARCHAR(255),
    source_repo         VARCHAR(255),
    source_storage_set_id TEXT REFERENCES repo_storage_sets(id),
    publish_ready       BOOLEAN NOT NULL DEFAULT FALSE,
    claim_token         VARCHAR(64),
    claimed_at          TIMESTAMPTZ,
    attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (num_nonnulls(user_id, org_id) = 1),
    CHECK (user_id IS NULL OR actor_id = user_id),
    CHECK (lower_name = LOWER(name)),
    CHECK (owner_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'),
    CHECK (LENGTH(name) <= 100 AND name ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'),
    CHECK (LOWER(name) !~ '\.(git|wiki|docs)$'),
    CHECK (LOWER(name) NOT IN (
        'agent', 'bookmarks', 'changes', 'commits', 'contributors', 'issues',
        'labels', 'landings', 'milestones', 'operations', 'pulls', 'settings',
        'stargazers', 'watchers', 'workflows'
    )),
    CHECK (BTRIM(default_bookmark) <> ''),
    CHECK (
        (operation_type IN ('init', 'import')
         AND NOT is_fork
         AND fork_id IS NULL
         AND source_repository_id IS NULL
         AND source_owner IS NULL
         AND source_repo IS NULL
         AND source_storage_set_id IS NULL)
        OR
        (operation_type = 'fork'
         AND is_fork
         AND fork_id IS NOT NULL
         AND source_repository_id = fork_id
         AND source_owner IS NOT NULL
         AND source_owner ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
         AND source_repo IS NOT NULL
         AND LENGTH(source_repo) <= 100
         AND source_repo ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
         AND LOWER(source_repo) !~ '\.(git|wiki|docs)$'
         AND source_storage_set_id = storage_set_id)
    ),
    CHECK (
        (claim_token IS NULL AND claimed_at IS NULL)
        OR (claim_token IS NOT NULL AND claimed_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX uq_repository_provisioning_user_name
    ON repository_provisioning_operations (user_id, lower_name)
    WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX uq_repository_provisioning_org_name
    ON repository_provisioning_operations (org_id, lower_name)
    WHERE org_id IS NOT NULL;

CREATE INDEX idx_repository_provisioning_reconcile
    ON repository_provisioning_operations (publish_ready, created_at, claimed_at, repository_id);

CREATE INDEX idx_repository_provisioning_source
    ON repository_provisioning_operations (source_repository_id)
    WHERE source_repository_id IS NOT NULL;

CREATE OR REPLACE FUNCTION validate_repository_provisioning_operation()
RETURNS TRIGGER AS $$
DECLARE
    v_owner_name TEXT;
    v_owner_type TEXT;
    v_owner_id BIGINT;
    v_source RECORD;
    v_authorized BOOLEAN;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.repository_id IS DISTINCT FROM OLD.repository_id
           OR NEW.operation_type IS DISTINCT FROM OLD.operation_type
           OR NEW.token IS DISTINCT FROM OLD.token
           OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
           OR NEW.storage_set_id IS DISTINCT FROM OLD.storage_set_id
           OR NEW.owner_name IS DISTINCT FROM OLD.owner_name
           OR NEW.user_id IS DISTINCT FROM OLD.user_id
           OR NEW.org_id IS DISTINCT FROM OLD.org_id
           OR NEW.name IS DISTINCT FROM OLD.name
           OR NEW.lower_name IS DISTINCT FROM OLD.lower_name
           OR NEW.description IS DISTINCT FROM OLD.description
           OR NEW.is_public IS DISTINCT FROM OLD.is_public
           OR NEW.default_bookmark IS DISTINCT FROM OLD.default_bookmark
           OR NEW.auto_init IS DISTINCT FROM OLD.auto_init
           OR NEW.is_fork IS DISTINCT FROM OLD.is_fork
           OR NEW.fork_id IS DISTINCT FROM OLD.fork_id
           OR NEW.source_repository_id IS DISTINCT FROM OLD.source_repository_id
           OR NEW.source_owner IS DISTINCT FROM OLD.source_owner
           OR NEW.source_repo IS DISTINCT FROM OLD.source_repo
           OR NEW.source_storage_set_id IS DISTINCT FROM OLD.source_storage_set_id THEN
            RAISE EXCEPTION USING
                ERRCODE = '0A000',
                MESSAGE = 'repository provisioning identity is immutable';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.user_id IS NOT NULL THEN
        v_owner_type := 'user';
        v_owner_id := NEW.user_id;
        SELECT username INTO v_owner_name FROM users WHERE id = NEW.user_id FOR KEY SHARE;
    ELSE
        v_owner_type := 'org';
        v_owner_id := NEW.org_id;
        SELECT name INTO v_owner_name FROM organizations WHERE id = NEW.org_id FOR KEY SHARE;
    END IF;
    IF v_owner_name IS NULL OR v_owner_name IS DISTINCT FROM NEW.owner_name THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'repository provisioning owner identity does not match';
    END IF;

    -- Authorization is part of the durable intent, not merely a stale service
    -- pre-check. Lock the exact actor/target membership rows so a concurrent
    -- demotion or removal either wins before this check or waits until the
    -- authorized reservation commits.
    PERFORM 1 FROM users WHERE id = NEW.actor_id FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '42501',
            MESSAGE = 'repository provisioning actor does not exist';
    END IF;
    IF NEW.user_id IS NOT NULL THEN
        IF NEW.actor_id IS DISTINCT FROM NEW.user_id THEN
            RAISE EXCEPTION USING ERRCODE = '42501',
                MESSAGE = 'repository provisioning actor cannot create for this user';
        END IF;
    ELSE
        PERFORM 1
        FROM org_members
        WHERE organization_id = NEW.org_id
          AND user_id = NEW.actor_id
          AND role = 'owner'
        FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE = '42501',
                MESSAGE = 'repository provisioning actor is not an organization owner';
        END IF;
    END IF;

    IF NEW.operation_type = 'fork' THEN
        SELECT r.user_id, r.org_id, r.name, r.storage_set_id, r.is_public,
               COALESCE(u.username, o.name) AS owner_name
        INTO v_source
        FROM repositories r
        LEFT JOIN users u ON u.id = r.user_id
        LEFT JOIN organizations o ON o.id = r.org_id
        WHERE r.id = NEW.source_repository_id
        FOR UPDATE OF r;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE = '23514',
                MESSAGE = 'repository provisioning source identity does not match';
        END IF;
        IF v_source.owner_name IS DISTINCT FROM NEW.source_owner
           OR v_source.name IS DISTINCT FROM NEW.source_repo
           OR v_source.storage_set_id IS DISTINCT FROM NEW.source_storage_set_id THEN
            RAISE EXCEPTION USING ERRCODE = '23514',
                MESSAGE = 'repository provisioning source identity does not match';
        END IF;

        -- The source row lock freezes ownership and visibility while the
        -- permission snapshot is taken. Lock whichever grant proves access so
        -- revocation cannot race the reservation commit.
        IF NOT v_source.is_public THEN
            -- Comparisons against an organization-owned source yield NULL for
            -- user_id. Normalize that three-valued result before using it as
            -- an authorization accumulator; otherwise every subsequent
            -- "IF NOT v_authorized" guard is skipped.
            v_authorized := COALESCE(v_source.user_id = NEW.actor_id, FALSE);
            IF NOT v_authorized AND v_source.org_id IS NOT NULL THEN
                SELECT TRUE INTO v_authorized
                FROM org_members om
                WHERE om.organization_id = v_source.org_id
                  AND om.user_id = NEW.actor_id
                  AND om.role = 'owner'
                FOR UPDATE OF om;
                v_authorized := COALESCE(v_authorized, FALSE);
            END IF;
            IF NOT v_authorized AND v_source.org_id IS NOT NULL THEN
                SELECT TRUE INTO v_authorized
                FROM team_repos tr
                JOIN teams t ON t.id = tr.team_id
                JOIN team_members tm ON tm.team_id = t.id
                JOIN org_members om
                  ON om.organization_id = t.organization_id
                 AND om.user_id = tm.user_id
                WHERE tr.repository_id = NEW.source_repository_id
                  AND tm.user_id = NEW.actor_id
                  AND t.organization_id = v_source.org_id
                  AND t.permission IN ('read', 'write', 'admin')
                LIMIT 1
                FOR UPDATE OF tr, t, tm, om;
                v_authorized := COALESCE(v_authorized, FALSE);
            END IF;
            IF NOT v_authorized THEN
                SELECT TRUE INTO v_authorized
                FROM collaborators c
                WHERE c.repository_id = NEW.source_repository_id
                  AND c.user_id = NEW.actor_id
                  AND c.permission IN ('read', 'write', 'admin')
                FOR UPDATE OF c;
                v_authorized := COALESCE(v_authorized, FALSE);
            END IF;
            IF NOT v_authorized THEN
                RAISE EXCEPTION USING ERRCODE = '42501',
                    MESSAGE = 'repository provisioning actor cannot read fork source';
            END IF;
        END IF;
    END IF;

    -- Global lock order for provisioning is source repository/grants first,
    -- then target namespace. Transfers and source mutations take the source
    -- row first as well, avoiding a source↔target deadlock cycle.
    PERFORM pg_advisory_xact_lock(hashtextextended(
        FORMAT('repository-provision:%s:%s:%s', v_owner_type, v_owner_id, NEW.lower_name),
        0
    ));

    IF EXISTS (
        SELECT 1 FROM repositories
        WHERE lower_name = NEW.lower_name
          AND ((NEW.user_id IS NOT NULL AND user_id = NEW.user_id)
               OR (NEW.org_id IS NOT NULL AND org_id = NEW.org_id))
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23505',
            MESSAGE = 'repository provisioning namespace is already occupied';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_repository_provisioning_validate_identity
    BEFORE INSERT OR UPDATE ON repository_provisioning_operations
    FOR EACH ROW EXECUTE FUNCTION validate_repository_provisioning_operation();

-- No repository row may become visible without a publish-ready, token-bound
-- reservation for the exact stable ID and all storage-defining metadata.
-- While the repo-host journal remains, block subsequent mutation/deletion so
-- recovery always observes the exact row it published.
CREATE OR REPLACE FUNCTION fence_repository_provisioning_operation()
RETURNS TRIGGER AS $$
DECLARE
    v_operation repository_provisioning_operations%ROWTYPE;
    v_authorized_token TEXT := NULLIF(
        current_setting('smithers.repository_provisioning_token', TRUE),
        ''
    );
    v_owner_type TEXT;
    v_owner_id BIGINT;
    v_enforce_insert_fence BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.user_id IS NOT NULL THEN
            v_owner_type := 'user'; v_owner_id := NEW.user_id;
        ELSE
            v_owner_type := 'org'; v_owner_id := NEW.org_id;
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended(
            FORMAT('repository-provision:%s:%s:%s', v_owner_type, v_owner_id, NEW.lower_name), 0
        ));
        SELECT * INTO v_operation
        FROM repository_provisioning_operations
        WHERE repository_id = NEW.id
        FOR UPDATE;

        IF NOT FOUND THEN
            SELECT enforce_insert_fence INTO STRICT v_enforce_insert_fence
            FROM repository_provisioning_control
            WHERE singleton;
            IF v_authorized_token IS NOT NULL
               OR v_enforce_insert_fence
               OR EXISTS (
                    SELECT 1 FROM repository_provisioning_operations
                    WHERE lower_name = NEW.lower_name
                      AND ((NEW.user_id IS NOT NULL AND user_id = NEW.user_id)
                           OR (NEW.org_id IS NOT NULL AND org_id = NEW.org_id))
               ) THEN
                RAISE EXCEPTION USING
                    ERRCODE = '55006',
                    MESSAGE = 'repository insertion requires an authorized published provisioning operation',
                    DETAIL = FORMAT('Repository %s has no matching publish-ready repo-host journal.', NEW.id),
                    HINT = 'Create repositories through the durable provisioning service.';
            END IF;
            RETURN NEW;
        END IF;

        IF NOT v_operation.publish_ready
           OR v_operation.token IS DISTINCT FROM v_authorized_token
           OR NEW.user_id IS DISTINCT FROM v_operation.user_id
           OR NEW.org_id IS DISTINCT FROM v_operation.org_id
           OR NEW.name IS DISTINCT FROM v_operation.name
           OR NEW.lower_name IS DISTINCT FROM v_operation.lower_name
           OR NEW.description IS DISTINCT FROM v_operation.description
           OR NEW.storage_set_id IS DISTINCT FROM v_operation.storage_set_id
           OR NEW.is_public IS DISTINCT FROM v_operation.is_public
           OR NEW.default_bookmark IS DISTINCT FROM v_operation.default_bookmark
           OR NEW.is_fork IS DISTINCT FROM v_operation.is_fork
           OR NEW.fork_id IS DISTINCT FROM v_operation.fork_id THEN
            RAISE EXCEPTION USING
                ERRCODE = '55006',
                MESSAGE = 'repository insertion requires an authorized published provisioning operation',
                DETAIL = FORMAT('Repository %s does not match a publish-ready repo-host journal.', NEW.id),
                HINT = 'Create repositories through the durable provisioning service.';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' AND (
       NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.org_id IS DISTINCT FROM OLD.org_id
       OR NEW.lower_name IS DISTINCT FROM OLD.lower_name) THEN
        IF NEW.user_id IS NOT NULL THEN
            v_owner_type := 'user'; v_owner_id := NEW.user_id;
        ELSE
            v_owner_type := 'org'; v_owner_id := NEW.org_id;
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended(
            FORMAT('repository-provision:%s:%s:%s', v_owner_type, v_owner_id, NEW.lower_name), 0
        ));
        IF EXISTS (
            SELECT 1 FROM repository_provisioning_operations
            WHERE lower_name = NEW.lower_name
              AND repository_id <> OLD.id
              AND ((NEW.user_id IS NOT NULL AND user_id = NEW.user_id)
                   OR (NEW.org_id IS NOT NULL AND org_id = NEW.org_id))
        ) THEN
            RAISE EXCEPTION USING ERRCODE = '55006',
                MESSAGE = 'repository provisioning namespace is reserved';
        END IF;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM repository_provisioning_operations
        WHERE repository_id = OLD.id
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '55006',
            MESSAGE = 'repository provisioning operation is still being finalized',
            DETAIL = FORMAT('Repository %s still has a repo-host provisioning journal.', OLD.id),
            HINT = 'Wait for the durable repository provisioning reconciler.';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_repositories_fence_provisioning_operation
    BEFORE INSERT OR UPDATE OR DELETE ON repositories
    FOR EACH ROW EXECUTE FUNCTION fence_repository_provisioning_operation();

-- A fork intent may be retried long after its original process exits. Keep its
-- exact source namespace and placement stable until the staged copy is ready.
CREATE OR REPLACE FUNCTION fence_repository_provisioning_source()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (
            SELECT 1
            FROM repository_provisioning_operations
            WHERE source_repository_id = OLD.id
        ) THEN
            RAISE EXCEPTION USING
                ERRCODE = '55006',
                MESSAGE = 'repository is the source of an active provisioning operation',
                DETAIL = FORMAT('Repository %s cannot be deleted until its fork snapshot is settled.', OLD.id),
                HINT = 'Wait for the durable repository provisioning reconciler.';
        END IF;
        RETURN OLD;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM repository_provisioning_operations
        WHERE source_repository_id = OLD.id
    ) AND (
        NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.org_id IS DISTINCT FROM OLD.org_id
        OR NEW.name IS DISTINCT FROM OLD.name
        OR NEW.lower_name IS DISTINCT FROM OLD.lower_name
        OR NEW.storage_set_id IS DISTINCT FROM OLD.storage_set_id
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '55006',
            MESSAGE = 'repository is the source of an active provisioning operation',
            DETAIL = FORMAT('Repository %s cannot move or be deleted until its fork snapshot is settled.', OLD.id),
            HINT = 'Wait for the durable repository provisioning reconciler.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_repositories_fence_provisioning_source
    BEFORE UPDATE OR DELETE ON repositories
    FOR EACH ROW EXECUTE FUNCTION fence_repository_provisioning_source();

-- Target owners must outlive unpublished repository reservations. Source
-- owners are already retained by the source repository and its existing guard.
CREATE OR REPLACE FUNCTION prevent_owner_delete_with_repositories()
RETURNS TRIGGER AS $$
DECLARE
    v_enforce_repository_storage BOOLEAN;
BEGIN
    SELECT enforce_repository_storage
    INTO STRICT v_enforce_repository_storage
    FROM legacy_mutation_fence_control
    WHERE singleton;

    IF TG_TABLE_NAME = 'users' AND (
        (v_enforce_repository_storage
         AND EXISTS (SELECT 1 FROM repositories WHERE user_id = OLD.id))
        OR EXISTS (SELECT 1 FROM repository_provisioning_operations WHERE user_id = OLD.id)
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '55006',
            MESSAGE = 'cannot delete user while repositories or provisioning operations still exist',
            HINT = 'Settle every durable repository workflow first.';
    ELSIF TG_TABLE_NAME = 'organizations' AND (
        (v_enforce_repository_storage
         AND EXISTS (SELECT 1 FROM repositories WHERE org_id = OLD.id))
        OR EXISTS (SELECT 1 FROM repository_provisioning_operations WHERE org_id = OLD.id)
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '55006',
            MESSAGE = 'cannot delete organization while repositories or provisioning operations still exist',
            HINT = 'Settle every durable repository workflow first.';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;
