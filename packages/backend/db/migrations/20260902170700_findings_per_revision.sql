-- Findings and analyzer execution state are pinned to immutable change
-- revisions. Keeping analyzer runs separate from findings lets clients tell a
-- clean completed run from one that failed, paused, or has not started yet.
CREATE TABLE analyzer_runs (
    id              BIGSERIAL PRIMARY KEY,
    repository_id   BIGINT NOT NULL,
    change_id       VARCHAR(255) NOT NULL,
    revision_seq    BIGINT NOT NULL CHECK (revision_seq > 0),
    name            TEXT NOT NULL CHECK (btrim(name) <> ''),
    state           VARCHAR(16) NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed', 'paused')),
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    paused_by       TEXT,
    paused_reason   TEXT,
    failure_reason  TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT analyzer_runs_pause_detail_check CHECK (
        (state = 'paused' AND paused_by IS NOT NULL AND btrim(paused_by) <> ''
            AND paused_reason IS NOT NULL AND btrim(paused_reason) <> '')
        OR (state <> 'paused' AND paused_by IS NULL AND paused_reason IS NULL)
    ),
    CONSTRAINT analyzer_runs_failure_detail_check CHECK (
        (state = 'failed' AND failure_reason IS NOT NULL AND btrim(failure_reason) <> '')
        OR (state <> 'failed' AND failure_reason IS NULL)
    ),
    FOREIGN KEY (repository_id, change_id, revision_seq)
        REFERENCES change_revisions(repository_id, change_id, seq) ON DELETE CASCADE,
    UNIQUE (repository_id, change_id, revision_seq, name)
);

CREATE INDEX idx_analyzer_runs_change_revision
    ON analyzer_runs (repository_id, change_id, revision_seq, name);

CREATE TABLE findings (
    id              BIGSERIAL PRIMARY KEY,
    repository_id   BIGINT NOT NULL,
    change_id       VARCHAR(255) NOT NULL,
    revision_seq    BIGINT NOT NULL CHECK (revision_seq > 0),
    analyzer        TEXT NOT NULL CHECK (btrim(analyzer) <> ''),
    source          VARCHAR(16) NOT NULL CHECK (source IN ('analyzer', 'reviewer')),
    path            TEXT NOT NULL CHECK (btrim(path) <> ''),
    line            BIGINT NOT NULL CHECK (line > 0),
    side            VARCHAR(8) NOT NULL DEFAULT 'right' CHECK (side IN ('left', 'right', 'both')),
    severity        TEXT NOT NULL CHECK (btrim(severity) <> ''),
    text            TEXT NOT NULL CHECK (btrim(text) <> ''),
    suggestion      TEXT,
    anchor_hash     TEXT,
    feedback        VARCHAR(16) CHECK (feedback IN ('useful', 'not_useful', 'fixed')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (repository_id, change_id, revision_seq)
        REFERENCES change_revisions(repository_id, change_id, seq) ON DELETE CASCADE
);

CREATE INDEX idx_findings_change_revision
    ON findings (repository_id, change_id, revision_seq, analyzer, id);
