-- Git LFS objects: content-addressed blob metadata with GCS location.
CREATE TABLE IF NOT EXISTS lfs_objects (
    id              BIGSERIAL PRIMARY KEY,
    repository_id   BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    oid             TEXT NOT NULL,
    size            BIGINT NOT NULL,
    gcs_path        TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, oid)
);

CREATE INDEX IF NOT EXISTS idx_lfs_objects_repo ON lfs_objects (repository_id);

-- Git LFS locks: advisory file locks for exclusive editing.
CREATE TABLE IF NOT EXISTS lfs_locks (
    id              BIGSERIAL PRIMARY KEY,
    repository_id   BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    path            VARCHAR(2048) NOT NULL,
    owner_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, path)
);

CREATE INDEX IF NOT EXISTS idx_lfs_locks_repo ON lfs_locks (repository_id);
CREATE INDEX IF NOT EXISTS idx_lfs_locks_owner ON lfs_locks (owner_id);

-- Git LFS metadata objects: OID → size registry used for batch API.
CREATE TABLE IF NOT EXISTS lfs_meta_objects (
    id             BIGSERIAL PRIMARY KEY,
    repository_id  BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    oid            VARCHAR(255) NOT NULL,
    size           BIGINT NOT NULL CHECK (size >= 0),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, oid)
);

CREATE INDEX IF NOT EXISTS idx_lfs_meta_objects_repository_id ON lfs_meta_objects (repository_id);
CREATE INDEX IF NOT EXISTS idx_lfs_meta_objects_oid ON lfs_meta_objects (oid);
