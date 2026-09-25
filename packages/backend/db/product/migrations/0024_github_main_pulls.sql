-- Smithers main follows GitHub main for repositories whose declared GitHub
-- policy is `mirror: "pull"`. One row per Smithers repository.
--
-- Requests only bump requested_generation, so any number of webhook
-- deliveries (duplicate or out of order) while a pull runs coalesce into one
-- more pull, which always targets GitHub's current tip. A claim increments
-- claim; every finish is fenced on it, so a worker whose lease expired and was
-- re-claimed writes nothing.
CREATE TABLE github_main_pulls (
    repository_id bigint PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
    requested_generation bigint NOT NULL DEFAULT 1,
    synced_generation bigint NOT NULL DEFAULT 0,
    claimed_generation bigint NOT NULL DEFAULT 0,
    claim bigint NOT NULL DEFAULT 0,
    state varchar(16) NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'running', 'synced', 'skipped', 'failed')),
    attempts integer NOT NULL DEFAULT 0,
    lease_expires_at timestamptz,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    github_repository text NOT NULL DEFAULT '',
    branch text NOT NULL DEFAULT '',
    policy varchar(16) NOT NULL DEFAULT '',
    policy_commit text NOT NULL DEFAULT '',
    github_head text NOT NULL DEFAULT '',
    smithers_head text NOT NULL DEFAULT '',
    last_error text NOT NULL DEFAULT '',
    last_checked_at timestamptz,
    last_synced_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX github_main_pulls_due_idx
    ON github_main_pulls (next_attempt_at)
    WHERE requested_generation > synced_generation;
