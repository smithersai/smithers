-- Stack submit persistence tables for stacked PR mappings and workflow triggers.
-- Forward-only migration.

CREATE TABLE IF NOT EXISTS stacks (
    id              BIGSERIAL PRIMARY KEY,
    repository_id   BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_ref      VARCHAR(255) NOT NULL DEFAULT 'main',
    state           VARCHAR(32) NOT NULL DEFAULT 'active'
                    CHECK (state IN ('active', 'landed', 'unsubmitted')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, user_id, target_ref, state)
);

CREATE INDEX IF NOT EXISTS idx_stacks_repository_state ON stacks (repository_id, state);

CREATE TABLE IF NOT EXISTS stack_changes (
    id              BIGSERIAL PRIMARY KEY,
    stack_id        BIGINT NOT NULL REFERENCES stacks(id) ON DELETE CASCADE,
    change_id       VARCHAR(255) NOT NULL,
    position        INTEGER NOT NULL,
    branch_name     VARCHAR(255) NOT NULL,
    pr_number       BIGINT,
    pr_state        VARCHAR(32),
    review_status   VARCHAR(32),
    ci_status       VARCHAR(32),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (stack_id, position),
    UNIQUE (stack_id, change_id)
);

CREATE INDEX IF NOT EXISTS idx_stack_changes_stack_id ON stack_changes (stack_id);
