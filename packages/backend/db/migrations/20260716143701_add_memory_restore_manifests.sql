-- Stable, content-free source inventory for isolated Hindsight restores.
CREATE TABLE memory_restore_manifests (
    restore_id      VARCHAR(128) PRIMARY KEY
                    CHECK (restore_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
    target_kind     VARCHAR(16) NOT NULL CHECK (target_kind IN ('user', 'project')),
    target_id       BIGINT NOT NULL CHECK (target_id > 0),
    operation_id    TEXT NOT NULL CHECK (BTRIM(operation_id) <> ''),
    source_manifest JSONB NOT NULL CHECK (jsonb_typeof(source_manifest) = 'object'),
    verified_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
