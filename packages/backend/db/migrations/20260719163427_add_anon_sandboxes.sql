-- Revision: 20260719163427.
-- Anonymous sandboxes: the security-bounded carve-out that lets a signed-out
-- visitor open an allowlisted public repository (../multi SPEC.md §3 — today
-- exactly smithersai/smithers) in a short-lived sandbox on its main branch.
--
-- Deliberately NO user_id and NO foreign key into any user-owned table:
-- anonymous work must never join or persist into a user's data. Access is a
-- bearer capability (token_hash = SHA-256 of a token returned once at
-- creation). Rows are hard-TTL'd (expires_at) and a reaper DELETES the VM —
-- never suspends it — so no anonymous disk is ever retained (cost lives in
-- retained disks, not compute). client_ip backs the per-IP concurrency cap
-- and is reaped with the row.

CREATE TABLE IF NOT EXISTS anon_sandboxes (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- owner/name of the allowlisted public repository (e.g.
    -- 'smithersai/smithers'); validated against the server-side allowlist
    -- before any row exists.
    repo_full_name     TEXT NOT NULL CHECK (LENGTH(repo_full_name) BETWEEN 3 AND 255),
    branch             TEXT NOT NULL DEFAULT 'main' CHECK (LENGTH(branch) BETWEEN 1 AND 128),
    vm_id              TEXT NOT NULL DEFAULT '',
    status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'starting', 'running', 'failed', 'deleted')),
    provisioning_stage TEXT NOT NULL DEFAULT '',
    -- SHA-256 hex of the creation-time access token. UNIQUE doubles as the
    -- integrity guard against token reuse across rows.
    token_hash         TEXT NOT NULL UNIQUE CHECK (LENGTH(token_hash) = 64),
    client_ip          TEXT NOT NULL DEFAULT '',
    expires_at         TIMESTAMPTZ NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at         TIMESTAMPTZ
);

-- Reaper + cap lookups only ever touch live rows.
CREATE INDEX IF NOT EXISTS idx_anon_sandboxes_status
    ON anon_sandboxes (status)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_anon_sandboxes_expires_at
    ON anon_sandboxes (expires_at)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_anon_sandboxes_client_ip
    ON anon_sandboxes (client_ip)
    WHERE deleted_at IS NULL;
