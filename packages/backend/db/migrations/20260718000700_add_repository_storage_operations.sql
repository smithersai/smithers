-- Revision: 20260718000700.
-- Repository ownership is stored in PostgreSQL while repository bytes live on
-- repo-host. A process stop between staging a delete/move and finalizing its
-- journal used to lose the only copy of the opaque repo-host token. Persist the
-- complete operation handle before storage can move so another API replica can
-- reconcile it from the repository's stable id.

-- Repository names are repo-host path segments. Old/direct writers could
-- persist a mismatched lower_name, traversal-shaped segment, sidecar suffix,
-- or route-reserved name even though the service rejects those values. Fail
-- before installing the constraint so an operator can move any pre-existing
-- storage explicitly instead of silently changing its address.
DO $repository_storage_identity_check$
DECLARE
    invalid_count BIGINT;
    invalid_sample TEXT;
BEGIN
    SELECT COUNT(*)
    INTO invalid_count
    FROM repositories
    WHERE lower_name <> LOWER(name)
       OR LENGTH(name) > 100
       OR name !~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
       OR LOWER(name) ~ '\.(git|wiki|docs)$'
       OR LOWER(name) IN (
            'agent', 'bookmarks', 'changes', 'commits', 'contributors',
            'issues', 'labels', 'landings', 'milestones', 'operations',
            'pulls', 'settings', 'stargazers', 'watchers', 'workflows'
       );

    IF invalid_count > 0 THEN
        SELECT STRING_AGG(id::text, ', ' ORDER BY id)
        INTO invalid_sample
        FROM (
            SELECT id
            FROM repositories
            WHERE lower_name <> LOWER(name)
               OR LENGTH(name) > 100
               OR name !~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
               OR LOWER(name) ~ '\.(git|wiki|docs)$'
               OR LOWER(name) IN (
                    'agent', 'bookmarks', 'changes', 'commits', 'contributors',
                    'issues', 'labels', 'landings', 'milestones', 'operations',
                    'pulls', 'settings', 'stargazers', 'watchers', 'workflows'
               )
            ORDER BY id
            LIMIT 20
        ) invalid;

        RAISE EXCEPTION USING
            ERRCODE = 'check_violation',
            MESSAGE = FORMAT('repository storage migration blocked by %s invalid repository identity row(s)', invalid_count),
            DETAIL = FORMAT('Invalid repository ids (first 20): %s', invalid_sample),
            HINT = 'Move invalid repo-host paths and make lower_name equal lower(name) before retrying migration 20260718000700.';
    END IF;
END;
$repository_storage_identity_check$;

ALTER TABLE repositories
    ADD CONSTRAINT ck_repositories_canonical_storage_identity
    CHECK (
        lower_name = LOWER(name)
        AND LENGTH(name) <= 100
        AND name ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
        AND LOWER(name) !~ '\.(git|wiki|docs)$'
        AND LOWER(name) NOT IN (
            'agent', 'bookmarks', 'changes', 'commits', 'contributors',
            'issues', 'labels', 'landings', 'milestones', 'operations',
            'pulls', 'settings', 'stargazers', 'watchers', 'workflows'
        )
    );

CREATE TABLE repository_storage_operations (
    repository_id   BIGINT PRIMARY KEY,
    operation_type  VARCHAR(16) NOT NULL
                    CHECK (operation_type IN ('delete', 'move')),
    token           VARCHAR(64) NOT NULL UNIQUE
                    CHECK (token ~ '^[0-9a-f]{64}$'),
    storage_set_id  TEXT NOT NULL REFERENCES repo_storage_sets(id),
    source_owner    VARCHAR(255) NOT NULL CHECK (BTRIM(source_owner) <> ''),
    source_repo     VARCHAR(255) NOT NULL CHECK (BTRIM(source_repo) <> ''),
    source_user_id  BIGINT,
    source_org_id   BIGINT,
    target_owner    VARCHAR(255),
    target_repo     VARCHAR(255),
    target_user_id  BIGINT,
    target_org_id   BIGINT,
    claim_token     VARCHAR(64),
    claimed_at      TIMESTAMPTZ,
    attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (num_nonnulls(source_user_id, source_org_id) = 1),
    CHECK (
        (operation_type = 'delete'
         AND target_owner IS NULL
         AND target_repo IS NULL
         AND target_user_id IS NULL
         AND target_org_id IS NULL)
        OR
        (operation_type = 'move'
         AND target_owner IS NOT NULL
         AND target_repo IS NOT NULL
         AND BTRIM(target_owner) <> ''
         AND BTRIM(target_repo) <> ''
         AND num_nonnulls(target_user_id, target_org_id) = 1)
    ),
    CHECK (
        (claim_token IS NULL AND claimed_at IS NULL)
        OR (claim_token IS NOT NULL AND claimed_at IS NOT NULL)
    )
);

CREATE INDEX idx_repository_storage_operations_reconcile
    ON repository_storage_operations (created_at, claimed_at, repository_id);

-- Expansion state must exist in the same migration that installs the trigger.
-- Previous-version pods continue writing while the migration job runs, so a
-- later migration cannot safely reopen a trigger that was strict at commit.
CREATE TABLE legacy_mutation_fence_control (
    singleton                   BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    enforce_repository_storage BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO legacy_mutation_fence_control (
    singleton, enforce_repository_storage
) VALUES (TRUE, FALSE);

-- Once an operation intent exists, every repository UPDATE/DELETE must be the
-- matching ownership transaction. This prevents a second transfer, delete, or
-- settings write from changing the stable-id decision while the first
-- repo-host journal is unresolved. The application authorizes its transaction
-- with SET LOCAL after taking the same per-repository advisory lock used when
-- the intent was inserted.
CREATE OR REPLACE FUNCTION fence_repository_storage_operation()
RETURNS TRIGGER AS $$
DECLARE
	v_operation repository_storage_operations%ROWTYPE;
	v_authorized_token TEXT := NULLIF(
		current_setting('smithers.repository_storage_operation_token', TRUE),
		''
	);
	v_has_operation BOOLEAN;
	v_identity_changed BOOLEAN;
	v_enforce_repository_storage BOOLEAN;
BEGIN
	SELECT enforce_repository_storage
	INTO STRICT v_enforce_repository_storage
	FROM legacy_mutation_fence_control
	WHERE singleton;

	SELECT * INTO v_operation
	FROM repository_storage_operations
	WHERE repository_id = OLD.id;
	v_has_operation := FOUND;

	IF TG_OP = 'DELETE' THEN
		IF NOT v_has_operation AND NOT v_enforce_repository_storage THEN
			RETURN OLD;
		END IF;
		IF NOT v_has_operation
		   OR v_operation.operation_type <> 'delete'
		   OR v_operation.token IS DISTINCT FROM v_authorized_token
		   OR OLD.user_id IS DISTINCT FROM v_operation.source_user_id
		   OR OLD.org_id IS DISTINCT FROM v_operation.source_org_id
		   OR OLD.name IS DISTINCT FROM v_operation.source_repo
		   OR OLD.lower_name IS DISTINCT FROM LOWER(v_operation.source_repo) THEN
			RAISE EXCEPTION USING
				ERRCODE = '55006',
				MESSAGE = 'repository deletion requires an authorized durable storage operation',
				DETAIL = FORMAT('Repository %s cannot be deleted without its matching repo-host journal.', OLD.id),
				HINT = 'Delete the repository through the durable repository service.';
		END IF;
		RETURN OLD;
	END IF;

	v_identity_changed :=
		NEW.user_id IS DISTINCT FROM OLD.user_id
		OR NEW.org_id IS DISTINCT FROM OLD.org_id
		OR NEW.name IS DISTINCT FROM OLD.name
		OR NEW.lower_name IS DISTINCT FROM OLD.lower_name
		OR NEW.storage_set_id IS DISTINCT FROM OLD.storage_set_id;

	IF NEW.name IS DISTINCT FROM OLD.name
	   OR NEW.lower_name IS DISTINCT FROM OLD.lower_name
	   OR NEW.storage_set_id IS DISTINCT FROM OLD.storage_set_id THEN
		RAISE EXCEPTION USING
			ERRCODE = '0A000',
			MESSAGE = 'repository storage namespace and placement are immutable',
			HINT = 'Use a durable repository rename or storage migration workflow before changing these fields.';
	END IF;

	IF v_identity_changed THEN
		IF NOT v_has_operation AND NOT v_enforce_repository_storage THEN
			RETURN NEW;
		END IF;
		IF NOT v_has_operation
		   OR v_operation.operation_type <> 'move'
		   OR v_operation.token IS DISTINCT FROM v_authorized_token
		   OR OLD.user_id IS DISTINCT FROM v_operation.source_user_id
		   OR OLD.org_id IS DISTINCT FROM v_operation.source_org_id
		   OR OLD.name IS DISTINCT FROM v_operation.source_repo
		   OR OLD.lower_name IS DISTINCT FROM LOWER(v_operation.source_repo)
		   OR NEW.user_id IS DISTINCT FROM v_operation.target_user_id
		   OR NEW.org_id IS DISTINCT FROM v_operation.target_org_id
		   OR NEW.name IS DISTINCT FROM v_operation.target_repo
		   OR NEW.lower_name IS DISTINCT FROM LOWER(v_operation.target_repo) THEN
			RAISE EXCEPTION USING
				ERRCODE = '55006',
				MESSAGE = 'repository ownership change requires an authorized durable storage operation',
				DETAIL = FORMAT('Repository %s ownership cannot change without its matching repo-host journal.', OLD.id),
				HINT = 'Transfer the repository through the durable repository service.';
		END IF;
		RETURN NEW;
	END IF;

	IF v_has_operation THEN
		RAISE EXCEPTION USING
			ERRCODE = '55006',
			MESSAGE = 'repository storage operation is already in progress',
			DETAIL = FORMAT('Repository %s has an unresolved repo-host storage journal.', OLD.id),
			HINT = 'Wait for the durable repository storage reconciler to complete the existing operation.';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_repositories_fence_storage_operation
    BEFORE UPDATE OR DELETE ON repositories
    FOR EACH ROW EXECUTE FUNCTION fence_repository_storage_operation();

-- FK cascades cannot call repo-host before repository metadata disappears.
-- Refuse a hard owner deletion while it still owns repositories; callers must
-- durably delete or transfer those repositories first. Soft user suspension is
-- an UPDATE and remains unaffected.
CREATE OR REPLACE FUNCTION prevent_owner_delete_with_repositories()
RETURNS TRIGGER AS $$
DECLARE
    v_enforce_repository_storage BOOLEAN;
BEGIN
    SELECT enforce_repository_storage
    INTO STRICT v_enforce_repository_storage
    FROM legacy_mutation_fence_control
    WHERE singleton;

    IF NOT v_enforce_repository_storage THEN
        RETURN OLD;
    END IF;

    IF TG_TABLE_NAME = 'users' AND EXISTS (
        SELECT 1 FROM repositories WHERE user_id = OLD.id
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '55006',
            MESSAGE = 'cannot delete user while repositories still exist',
            HINT = 'Delete or transfer every repository through the durable repository workflow first.';
    ELSIF TG_TABLE_NAME = 'organizations' AND EXISTS (
        SELECT 1 FROM repositories WHERE org_id = OLD.id
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = '55006',
            MESSAGE = 'cannot delete organization while repositories still exist',
            HINT = 'Delete or transfer every repository through the durable repository workflow first.';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_prevent_repository_cascade
    BEFORE DELETE ON users
    FOR EACH ROW EXECUTE FUNCTION prevent_owner_delete_with_repositories();

CREATE TRIGGER trg_organizations_prevent_repository_cascade
    BEFORE DELETE ON organizations
    FOR EACH ROW EXECUTE FUNCTION prevent_owner_delete_with_repositories();
