-- NixOS environment images: the compute path for kind=vm and kind=desktop
-- workspaces. One row per (repository, kind, closure hash); repository_id NULL
-- rows are the platform base images (nix/modules/base.nix, plus desktop.nix for
-- kind=desktop) every repository without a registered image boots from. The
-- image tag is the closure hash of the NixOS toplevel, so a row is immutable
-- content: re-registering the same closure is an idempotent upsert.
CREATE TABLE IF NOT EXISTS sandbox_environment_images (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id   BIGINT REFERENCES repositories(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL CHECK (kind IN ('vm', 'desktop')),
    source          TEXT NOT NULL DEFAULT '.smithers/environment.nix',
    source_revision TEXT NOT NULL DEFAULT '',
    closure_hash    TEXT NOT NULL CHECK (closure_hash <> ''),
    image           TEXT NOT NULL CHECK (image <> ''),
    status          TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'retired')),
    created_by      BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS sandbox_environment_images_closure
    ON sandbox_environment_images ((COALESCE(repository_id, 0)), kind, closure_hash);
CREATE INDEX IF NOT EXISTS sandbox_environment_images_ready
    ON sandbox_environment_images ((COALESCE(repository_id, 0)), kind, created_at DESC)
    WHERE status = 'ready';

-- Workspaces record the image they booted from and, for kind=desktop, the
-- current stream session: an opaque id, the SHA-256 of the relay token (the
-- plaintext is returned once by POST .../desktop/session), and its expiry.
ALTER TABLE workspaces
    ADD COLUMN environment_image TEXT NOT NULL DEFAULT '',
    ADD COLUMN desktop_session_id TEXT NOT NULL DEFAULT '',
    ADD COLUMN desktop_session_token_hash TEXT NOT NULL DEFAULT '',
    ADD COLUMN desktop_session_expires_at TIMESTAMPTZ;
