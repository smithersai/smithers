-- Repo gateways: one durable `smithers gateway` control-plane VM per user+repo.
-- The gateway is a long-lived process inside a Freestyle micro-VM (like the
-- workspace terminal VMs), reached over Freestyle HTTPS ingress
-- (external port 443 -> in-VM 7331).
--
-- Token storage: the stock `smithers gateway` accepts ONLY the exact operator
-- token it was started with (fixed in-memory map; no DB tokens, no RPC mint),
-- so per-request ephemeral tokens are impossible without restarting the
-- gateway (which would kill live runs). The operator token is therefore
-- stored encrypted at rest (AES-256-GCM via the same codec that protects
-- repository secrets) plus a SHA-256 hash for audit. Plaintext is never
-- persisted.
CREATE TABLE IF NOT EXISTS repo_gateways (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id         BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vm_id                 TEXT NOT NULL DEFAULT '',
    base_url              TEXT NOT NULL DEFAULT '',
    auth_token_hash       TEXT NOT NULL DEFAULT '',
    auth_token_ciphertext TEXT NOT NULL DEFAULT '',
    status                VARCHAR(16) NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'starting', 'running', 'suspended', 'stopped', 'failed')),
    last_activity_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at            TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one live gateway per user+repo. Failed/stopped/tombstoned rows do not
-- block a re-provision.
CREATE UNIQUE INDEX IF NOT EXISTS uq_repo_gateways_active
    ON repo_gateways (repository_id, user_id)
    WHERE deleted_at IS NULL
      AND status IN ('starting', 'running', 'suspended');

CREATE INDEX IF NOT EXISTS idx_repo_gateways_status
    ON repo_gateways (status)
    WHERE deleted_at IS NULL;
