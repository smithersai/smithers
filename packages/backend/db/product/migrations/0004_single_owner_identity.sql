-- Exactly one trusted owner may claim a self-hosted installation. The
-- singleton constraint is the concurrency boundary for first-run bootstrap.
CREATE TABLE self_host_owners (
    singleton       BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    user_id         BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE local_credentials (
    user_id              BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    password_hash        TEXT NOT NULL,
    password_changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
