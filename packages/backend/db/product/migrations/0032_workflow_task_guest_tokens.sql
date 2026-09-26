-- A NixOS CI guest runs exactly one job (one workflow_tasks row). To restore
-- and save that job's workflow caches and to upload or download its run's
-- artifacts, the guest needs a credential the /internal cache and artifact
-- routes accept. This table holds that credential: one random bearer token
-- per task, stored only as its SHA-256, minted by the sandbox scheduler when
-- the job starts and deleted when the job ends. It is a separate table so the
-- shape of workflow_tasks (and every SELECT * over it) does not change.
CREATE TABLE workflow_task_guest_tokens (
    workflow_task_id bigint PRIMARY KEY REFERENCES workflow_tasks(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    CONSTRAINT workflow_task_guest_tokens_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$')
);
