-- The workspace coding host needs a repository-scoped API credential so the
-- coding/vibe landing flow can read bookmarks and create/queue landing
-- requests. landing_token_id records the token the gateway row owns so
-- teardown revokes exactly that credential and nothing else.
ALTER TABLE repo_gateways
    ADD COLUMN landing_token_id BIGINT REFERENCES access_tokens(id) ON DELETE SET NULL;
