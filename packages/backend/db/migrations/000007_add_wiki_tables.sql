-- Wiki pages (metadata stored in DB, content stored in Git)
CREATE TABLE IF NOT EXISTS wiki_pages (
    id              BIGSERIAL PRIMARY KEY,
    repository_id   BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    last_commit_sha VARCHAR(64) NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (repository_id, name)
);

CREATE INDEX idx_wiki_pages_repository_id ON wiki_pages(repository_id);
CREATE INDEX idx_wiki_pages_name ON wiki_pages(repository_id, name);

-- Wiki revision history
CREATE TABLE IF NOT EXISTS wiki_revisions (
    id              BIGSERIAL PRIMARY KEY,
    wiki_page_id    BIGINT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
    commit_sha      VARCHAR(64) NOT NULL,
    message         TEXT NOT NULL DEFAULT '',
    author_id       BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wiki_revisions_page_id ON wiki_revisions(wiki_page_id, created_at DESC);
CREATE INDEX idx_wiki_revisions_commit_sha ON wiki_revisions(commit_sha);
