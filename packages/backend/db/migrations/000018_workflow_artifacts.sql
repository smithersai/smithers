DO $$
BEGIN
    IF to_regclass('public.workflow_artifacts') IS NULL THEN
        CREATE TABLE workflow_artifacts (
            id                  BIGSERIAL PRIMARY KEY,
            repository_id       BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
            workflow_run_id     BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
            name                VARCHAR(255) NOT NULL,
            size                BIGINT NOT NULL DEFAULT 0 CHECK (size >= 0),
            content_type        VARCHAR(255) NOT NULL DEFAULT 'application/octet-stream',
            status              VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready')),
            gcs_key             TEXT NOT NULL,
            confirmed_at        TIMESTAMPTZ,
            expires_at          TIMESTAMPTZ NOT NULL,
            release_tag         TEXT,
            release_asset_name  TEXT,
            release_attached_at TIMESTAMPTZ,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (workflow_run_id, name)
        );
    ELSE
        IF EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'workflow_artifacts'
              AND column_name = 'gcs_path'
        ) AND NOT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'workflow_artifacts'
              AND column_name = 'gcs_key'
        ) THEN
            ALTER TABLE workflow_artifacts RENAME COLUMN gcs_path TO gcs_key;
        END IF;

        IF EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'workflow_artifacts'
              AND column_name = 'size_bytes'
        ) AND NOT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'workflow_artifacts'
              AND column_name = 'size'
        ) THEN
            ALTER TABLE workflow_artifacts RENAME COLUMN size_bytes TO size;
        END IF;

        ALTER TABLE workflow_artifacts
            ADD COLUMN IF NOT EXISTS repository_id BIGINT,
            ADD COLUMN IF NOT EXISTS status VARCHAR(32),
            ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS release_tag TEXT,
            ADD COLUMN IF NOT EXISTS release_asset_name TEXT,
            ADD COLUMN IF NOT EXISTS release_attached_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

        UPDATE workflow_artifacts AS wa
        SET repository_id = wr.repository_id
        FROM workflow_runs AS wr
        WHERE wa.repository_id IS NULL
          AND wr.id = wa.workflow_run_id;

        UPDATE workflow_artifacts
        SET status = 'ready'
        WHERE status IS NULL OR status = '';

        UPDATE workflow_artifacts
        SET updated_at = COALESCE(updated_at, created_at, NOW());

        ALTER TABLE workflow_artifacts
            ALTER COLUMN repository_id SET NOT NULL,
            ALTER COLUMN size SET DEFAULT 0,
            ALTER COLUMN size SET NOT NULL,
            ALTER COLUMN content_type SET DEFAULT 'application/octet-stream',
            ALTER COLUMN content_type SET NOT NULL,
            ALTER COLUMN status SET DEFAULT 'pending',
            ALTER COLUMN status SET NOT NULL,
            ALTER COLUMN gcs_key SET NOT NULL,
            ALTER COLUMN updated_at SET DEFAULT NOW();

        ALTER TABLE workflow_artifacts
            DROP COLUMN IF EXISTS retention_days;

        IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conname = 'workflow_artifacts_repository_id_fkey'
        ) THEN
            ALTER TABLE workflow_artifacts
                ADD CONSTRAINT workflow_artifacts_repository_id_fkey
                FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE;
        END IF;

        IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conname = 'workflow_artifacts_status_check'
        ) THEN
            ALTER TABLE workflow_artifacts
                ADD CONSTRAINT workflow_artifacts_status_check
                CHECK (status IN ('pending', 'ready'));
        END IF;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_repo_id
    ON workflow_artifacts (repository_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_run_id
    ON workflow_artifacts (workflow_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_expires_at
    ON workflow_artifacts (expires_at);
