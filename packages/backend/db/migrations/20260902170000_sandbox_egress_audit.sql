CREATE TABLE sandbox_egress_audit (
    id BIGSERIAL PRIMARY KEY,
    sandbox_id TEXT NOT NULL,
    resource_kind TEXT NOT NULL CHECK (length(resource_kind) BETWEEN 1 AND 64),
    resource_id TEXT NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 200),
    repository_id BIGINT REFERENCES repositories(id) ON DELETE SET NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    host VARCHAR(253) NOT NULL CHECK (length(host) > 0),
    method VARCHAR(16) NOT NULL CHECK (length(method) > 0),
    path VARCHAR(2048) NOT NULL,
    status INTEGER NOT NULL CHECK (status BETWEEN 0 AND 999),
    allowed BOOLEAN NOT NULL,
    swapped_secret_names TEXT[] NOT NULL DEFAULT '{}',
    transform_summary JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(transform_summary) = 'object' AND pg_column_size(transform_summary) <= 16384),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (cardinality(swapped_secret_names) <= 64),
    CHECK (array_position(swapped_secret_names, NULL) IS NULL)
);

CREATE INDEX sandbox_egress_audit_resource_occurred_idx
    ON sandbox_egress_audit (resource_kind, resource_id, occurred_at DESC);

CREATE INDEX sandbox_egress_audit_repository_occurred_idx
    ON sandbox_egress_audit (repository_id, occurred_at DESC);
