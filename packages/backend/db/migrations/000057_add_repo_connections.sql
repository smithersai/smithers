CREATE TABLE IF NOT EXISTS repo_connections (
    id               BIGSERIAL PRIMARY KEY,
    user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repo_owner       VARCHAR(255) NOT NULL,
    repo_name        VARCHAR(255) NOT NULL,
    repo_owner_lower VARCHAR(255) NOT NULL,
    repo_name_lower  VARCHAR(255) NOT NULL,
    license_spdx_id  VARCHAR(64) NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, repo_owner_lower, repo_name_lower)
);

CREATE INDEX IF NOT EXISTS idx_repo_connections_user_id ON repo_connections (user_id);
