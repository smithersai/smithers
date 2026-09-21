-- Deploy keys (per-repository SSH keys)
CREATE TABLE IF NOT EXISTS deploy_keys (
    id               BIGSERIAL PRIMARY KEY,
    repository_id    BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    title            TEXT NOT NULL,
    key_fingerprint  TEXT NOT NULL,
    public_key       TEXT NOT NULL,
    read_only        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, key_fingerprint)
);

CREATE INDEX idx_deploy_keys_repo_id ON deploy_keys (repository_id);
CREATE INDEX idx_deploy_keys_fingerprint ON deploy_keys (key_fingerprint);
