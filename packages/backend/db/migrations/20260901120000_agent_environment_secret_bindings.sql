-- Egress-proxy bindings for repository agent-environment secrets.
--
-- A secret with hosts + match_headers is delivered through the per-sandbox
-- credential-substituting egress proxy: the guest only ever sees NAME=NAME and
-- the proxy swaps the placeholder on requests to exactly these hosts and header
-- locations. Unbound secrets (empty arrays) keep the legacy environment path.
-- Adding NOT NULL columns with a constant DEFAULT is a metadata-only change on
-- PostgreSQL 11+; existing rows read back as empty arrays.
-- smithers:migration-contract-reviewed
ALTER TABLE repository_agent_environment_secrets
    ADD COLUMN IF NOT EXISTS hosts TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS match_headers TEXT[] NOT NULL DEFAULT '{}';
