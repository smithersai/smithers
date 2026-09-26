-- The repository wiki the mythical stack keeps current. After every fold the
-- stack worker refreshes the pages .smithers/coding-project.json declares
-- (coding/wiki on a short-lived wiki workspace) and publishes the verified
-- pages as generated-<id>. One row per repository with a stack.
--
-- generation qualifies every launch: a projection of an older generation
-- changes nothing. commit is the landed main the current or last attempt
-- reviews (from the stack tip with the same tree); published_commit is the
-- landed main the published pages were reviewed at.
CREATE TABLE mythical_wikis (
    repository_id bigint PRIMARY KEY REFERENCES mythical_stacks(repository_id) ON DELETE CASCADE,
    -- Optimistic concurrency between the stack worker and run projections.
    version bigint NOT NULL DEFAULT 0,
    generation bigint NOT NULL DEFAULT 0,
    state varchar(16) NOT NULL DEFAULT 'idle' CHECK (state IN ('idle', 'running', 'failed', 'off')),
    -- A person asked for a refresh now (or a retry); cleared by the launch.
    requested boolean NOT NULL DEFAULT false,
    commit_id text NOT NULL DEFAULT '',
    base_commit text NOT NULL DEFAULT '',
    workspace_id text NOT NULL DEFAULT '',
    run_id text NOT NULL DEFAULT '',
    -- The run's terminal outcome, recorded by the projection: '' while it
    -- runs, else succeeded or failed[: reason]. result is its output.
    outcome text NOT NULL DEFAULT '',
    result jsonb CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
    attempt integer NOT NULL DEFAULT 0,
    started_at timestamptz,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    published_commit text NOT NULL DEFAULT '',
    published_base text NOT NULL DEFAULT '',
    published_at timestamptz,
    -- The retained receipt of the published refresh: run ids, source
    -- revision, artifact digest, and per page its review digest and sources.
    receipt jsonb CHECK (receipt IS NULL OR jsonb_typeof(receipt) = 'object'),
    -- Per page: slug, title, kind, the generated body and its digest, the
    -- revision last written, the input digest, and whether a person edited it.
    pages jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(pages) = 'array'),
    -- The published refresh's reviews, carried into the next refresh.
    pool jsonb CHECK (pool IS NULL OR jsonb_typeof(pool) = 'object'),
    error text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT now()
);
