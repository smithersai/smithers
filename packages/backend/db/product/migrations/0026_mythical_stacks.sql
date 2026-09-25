-- The mythical stack: one linear history of logical changes per repository
-- (refs/heads/mythical), written only by the stack worker. Git refs hold the
-- history; these rows hold the worker's claim, its prepared operation and
-- the provenance the monitoring API reads.
--
-- requested_generation / processed_generation coalesce any number of
-- requests (bootstrap, a moved main, a lane submission) into one more run.
-- claim fences every finish, so a worker whose lease expired writes nothing.
-- pending_op is the prepared ref update persisted before the push; recovery
-- compares the repository's refs with it before anything else runs.
CREATE TABLE mythical_stacks (
    repository_id bigint PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
    -- Who turned the stack on; deleting that user keeps the repository's stack.
    actor_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
    state varchar(16) NOT NULL DEFAULT 'bootstrapping'
        CHECK (state IN ('bootstrapping', 'active', 'frozen')),
    reason text NOT NULL DEFAULT '',
    -- The requested generation of the newest unfinished reset (0: none). A
    -- finishing reset clears only its own generation, never a newer one.
    reset_generation bigint NOT NULL DEFAULT 0,
    bootstrap_depth integer NOT NULL DEFAULT 100 CHECK (bootstrap_depth BETWEEN 1 AND 500),
    max_parallel integer NOT NULL DEFAULT 2 CHECK (max_parallel BETWEEN 1 AND 8),
    tip_commit text NOT NULL DEFAULT '',
    tip_change text NOT NULL DEFAULT '',
    notes_commit text NOT NULL DEFAULT '',
    landed_main text NOT NULL DEFAULT '',
    generation bigint NOT NULL DEFAULT 1,
    requested_generation bigint NOT NULL DEFAULT 1,
    processed_generation bigint NOT NULL DEFAULT 0,
    claimed_generation bigint NOT NULL DEFAULT 0,
    claim bigint NOT NULL DEFAULT 0,
    running boolean NOT NULL DEFAULT false,
    lease_expires_at timestamptz,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    attempts integer NOT NULL DEFAULT 0,
    pending_op jsonb CHECK (pending_op IS NULL OR jsonb_typeof(pending_op) = 'object'),
    last_error text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mythical_stacks_due_idx
    ON mythical_stacks (next_attempt_at)
    WHERE requested_generation > processed_generation;

-- The stack's changes, root first. A write that rewrites the stack from a
-- position replaces the rows from that position on.
CREATE TABLE mythical_changes (
    repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    position integer NOT NULL CHECK (position >= 0),
    change_id text NOT NULL,
    commit_id text NOT NULL,
    title text NOT NULL DEFAULT '',
    kind varchar(16) NOT NULL CHECK (kind IN ('bootstrap', 'fold', 'item')),
    item_id uuid,
    issue_number bigint,
    predecessor text NOT NULL DEFAULT '',
    folded_from text NOT NULL DEFAULT '',
    PRIMARY KEY (repository_id, position)
);

-- One row per issue (or chat request, without an issue) moving through the
-- stack. generation qualifies every launch and candidate so a stale run's
-- projection or a superseded candidate can never overwrite a newer one.
CREATE TABLE mythical_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id bigint NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    issue_number bigint CHECK (issue_number IS NULL OR issue_number > 0),
    issue_title text NOT NULL DEFAULT '',
    issue_url text NOT NULL DEFAULT '',
    issue_digest text NOT NULL DEFAULT '',
    -- 'issue' items come from GitHub; 'chat' items are results a workspace
    -- handed to the stack without an issue.
    source varchar(8) NOT NULL DEFAULT 'issue' CHECK (source IN ('issue', 'chat')),
    -- Optimistic concurrency between the stack worker and run projections.
    version bigint NOT NULL DEFAULT 0,
    state varchar(16) NOT NULL DEFAULT 'queued'
        CHECK (state IN ('queued', 'skipped', 'cancelled', 'running', 'delivering', 'integrating', 'verifying',
                         'proposing', 'waiting', 'proposed', 'landed', 'rejected', 'retrying', 'blocked')),
    reason text NOT NULL DEFAULT '',
    attempt integer NOT NULL DEFAULT 0,
    generation bigint NOT NULL DEFAULT 0,
    lane integer CHECK (lane IS NULL OR lane >= 0),
    workspace_id text NOT NULL DEFAULT '',
    base_commit text NOT NULL DEFAULT '',
    candidate_base text NOT NULL DEFAULT '',
    candidate_head text NOT NULL DEFAULT '',
    candidate_verified boolean NOT NULL DEFAULT false,
    request_run_id text NOT NULL DEFAULT '',
    vibe_run_id text NOT NULL DEFAULT '',
    verify_run_id text NOT NULL DEFAULT '',
    -- Terminal outcomes of the current attempt's runs, recorded by the
    -- projection: '' while running, else validated, changes-requested,
    -- blocked, declined, submitted, passed or failed[: reason].
    request_outcome text NOT NULL DEFAULT '',
    vibe_outcome text NOT NULL DEFAULT '',
    verify_outcome text NOT NULL DEFAULT '',
    summary text NOT NULL DEFAULT '',
    plan jsonb CHECK (plan IS NULL OR jsonb_typeof(plan) = 'object'),
    integration jsonb CHECK (integration IS NULL OR jsonb_typeof(integration) = 'object'),
    checks jsonb CHECK (checks IS NULL OR jsonb_typeof(checks) = 'object'),
    pr_number bigint,
    pr_url text NOT NULL DEFAULT '',
    pr_state text NOT NULL DEFAULT '',
    pr_head text NOT NULL DEFAULT '',
    pr_merge_commit text NOT NULL DEFAULT '',
    pending_op jsonb CHECK (pending_op IS NULL OR jsonb_typeof(pending_op) = 'object'),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX mythical_items_issue_idx
    ON mythical_items (repository_id, issue_number)
    WHERE issue_number IS NOT NULL;
CREATE INDEX mythical_items_repository_idx ON mythical_items (repository_id, state, created_at);
