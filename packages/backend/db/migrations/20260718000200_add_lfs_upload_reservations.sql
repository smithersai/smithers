-- Revision: 20260718000200.
-- Reserve billing quota before handing a client a direct-to-GCS LFS upload
-- capability. Expiry invalidates/refreshes the capability, but rows continue
-- counting toward quota until the staged object is promoted or confirmed
-- deleted; this keeps abandoned physical bytes inside the aggregate cap.
CREATE TABLE IF NOT EXISTS lfs_upload_reservations (
    id              BIGSERIAL PRIMARY KEY,
    repository_id   BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    oid             TEXT NOT NULL,
    size            BIGINT NOT NULL CHECK (size >= 0),
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, oid)
);

CREATE INDEX IF NOT EXISTS idx_lfs_upload_reservations_repo
    ON lfs_upload_reservations (repository_id);
CREATE INDEX IF NOT EXISTS idx_lfs_upload_reservations_expiry
    ON lfs_upload_reservations (expires_at);
