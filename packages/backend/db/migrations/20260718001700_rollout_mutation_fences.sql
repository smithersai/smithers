-- Revision: 20260718001700.
-- Migrations precede a rolling API replacement and survive an application
-- rollback. Keep legacy repository mutations available until the deployment
-- has proved every previous-version API pod is gone, while immediately
-- fencing any row that already has a durable operation. The same post-drain
-- switch enables the release-deletion intent protocol in application code.
-- The repository-storage switch is created by migration 007 in the same
-- transaction that first installs its trigger, avoiding any strict interval
-- while previous-version pods are still serving.
ALTER TABLE legacy_mutation_fence_control
    ADD COLUMN enforce_release_deletion BOOLEAN NOT NULL DEFAULT FALSE;

-- Active operation rows are always fenced. In compatibility mode only a
-- mutation with no durable operation is admitted, matching the parent binary.
-- The post-drain transition flips enforce_repository_storage and makes such
-- unjournaled deletes/transfers fail closed for the new fleet.
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

-- A previous-version confirmer does not know about the deleting state. Once a
-- new replica has claimed an artifact, permit only lease-token/timestamp
-- changes; skip every attempt to restore or otherwise rewrite the claim. A
-- previous-version hard DELETE remains safe because migration 006 enqueues
-- both exact object names before metadata disappears.
CREATE OR REPLACE FUNCTION guard_artifact_deletion_claim()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status = 'deleting'
       AND (
           NEW.status IS DISTINCT FROM 'deleting'
           OR (to_jsonb(NEW) - 'deletion_token' - 'updated_at')
              IS DISTINCT FROM
              (to_jsonb(OLD) - 'deletion_token' - 'updated_at')
       ) THEN
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_workflow_artifacts_guard_deletion_claim
    BEFORE UPDATE ON workflow_artifacts
    FOR EACH ROW EXECUTE FUNCTION guard_artifact_deletion_claim();

CREATE TRIGGER trg_issue_artifacts_guard_deletion_claim
    BEFORE UPDATE ON issue_artifacts
    FOR EACH ROW EXECUTE FUNCTION guard_artifact_deletion_claim();
