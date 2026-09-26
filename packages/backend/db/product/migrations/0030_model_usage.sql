-- One row per platform-key model call made through the metered model proxy.
-- The row is written after credit is reserved and before the provider is
-- contacted, then finished with the provider's reported usage. Money lives in
-- the credit ledger: join reservation_id to credit_reservations for the bound
-- held and the amount charged. A row left pending is a call whose process
-- stopped before it finished; its reservation is charged at the bound.

CREATE TABLE model_usage (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_key text NOT NULL UNIQUE CHECK (request_key <> ''),
    credit_account_id bigint NOT NULL REFERENCES credit_accounts(id),
    reservation_id bigint NOT NULL REFERENCES credit_reservations(id),
    owner_type text NOT NULL CHECK (owner_type IN ('user', 'org')),
    owner_id bigint NOT NULL CHECK (owner_id > 0),
    source text NOT NULL CHECK (source IN ('agent_run', 'workspace', 'repo_gateway', 'flow_host', 'recommendation', 'app')),
    user_id bigint,
    repository_id bigint,
    workspace_id text,
    workflow_run_id bigint,
    reference text NOT NULL DEFAULT '',
    provider text NOT NULL,
    model text NOT NULL,
    stream boolean NOT NULL DEFAULT false,
    outcome text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'succeeded', 'failed', 'unknown')),
    input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    cache_read_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
    cache_write_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
    cost_nanos bigint CHECK (cost_nanos >= 0),
    upstream_status integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    settled_at timestamptz,
    CHECK ((outcome = 'pending') = (settled_at IS NULL))
);

CREATE INDEX idx_model_usage_owner ON model_usage (owner_type, owner_id, created_at DESC);
CREATE INDEX idx_model_usage_repository ON model_usage (repository_id, created_at DESC) WHERE repository_id IS NOT NULL;
CREATE INDEX idx_model_usage_pending ON model_usage (created_at) WHERE outcome = 'pending';
