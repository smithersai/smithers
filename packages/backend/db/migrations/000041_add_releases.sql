CREATE TABLE releases (
    id            BIGSERIAL PRIMARY KEY,
    repository_id BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    publisher_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tag_name      VARCHAR(255) NOT NULL,
    target        VARCHAR(255) NOT NULL DEFAULT '',
    title         VARCHAR(255) NOT NULL DEFAULT '',
    body          TEXT NOT NULL DEFAULT '',
    sha           VARCHAR(255) NOT NULL DEFAULT '',
    is_draft      BOOLEAN NOT NULL DEFAULT FALSE,
    is_prerelease BOOLEAN NOT NULL DEFAULT FALSE,
    is_tag        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, tag_name)
);

CREATE INDEX idx_releases_repo_id ON releases (repository_id, created_at DESC);
CREATE INDEX idx_releases_tag_name ON releases (repository_id, tag_name);

CREATE TABLE release_assets (
    id             BIGSERIAL PRIMARY KEY,
    release_id     BIGINT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
    uploader_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name           VARCHAR(255) NOT NULL,
    size           BIGINT NOT NULL DEFAULT 0 CHECK (size >= 0),
    download_count BIGINT NOT NULL DEFAULT 0 CHECK (download_count >= 0),
    status         VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready')),
    gcs_key        TEXT NOT NULL,
    content_type   VARCHAR(255) NOT NULL DEFAULT 'application/octet-stream',
    confirmed_at   TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (release_id, name)
);

CREATE INDEX idx_release_assets_release_id ON release_assets (release_id, created_at DESC);
