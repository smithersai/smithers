ALTER TABLE commit_statuses
    ADD COLUMN targets_affected BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN targets_ran BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN targets_cached BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN duration_ms BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
    ADD CONSTRAINT commit_statuses_targets_affected_nonnegative CHECK (targets_affected >= 0),
    ADD CONSTRAINT commit_statuses_targets_ran_nonnegative CHECK (targets_ran >= 0),
    ADD CONSTRAINT commit_statuses_targets_cached_nonnegative CHECK (targets_cached >= 0),
    ADD CONSTRAINT commit_statuses_duration_ms_nonnegative CHECK (duration_ms >= 0);
