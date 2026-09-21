-- Ticket 0110: approvals flow (human-in-the-loop).
--
-- Agent runtime emits a pending approval via the guest-agent
-- MethodEmitApprovalRequest (gated by CapabilityApprovalsEmit, ticket 0131);
-- plue persists a row; Electric shape `approvals` delivers it to clients;
-- clients POST /api/repos/{owner}/{repo}/approvals/{id}/decide.
--
-- Expiry policy: CLIENT-SIDE FILTER ONLY. Rows with expires_at < now() may
-- still have state='pending' in the DB; no background sweeper in v1.
-- Clients observe expires_at and render expired rows locally. This keeps
-- the decide endpoint race-free (nothing can mutate pending state behind
-- the HTTP handler's back).
--
-- Anchoring: session_id NOT NULL in v1. Run-anchored approvals (ticket 0111
-- run shape) can add an optional run_id column later without breaking the
-- existing constraint.
--
-- Forward-only migration; atlas.sum regenerated via `atlas migrate hash`.

CREATE TABLE IF NOT EXISTS approvals (
    id             UUID PRIMARY KEY,
    session_id     UUID NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    repository_id  BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    state          TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'expired')),
    kind           TEXT NOT NULL,
    title          TEXT NOT NULL,
    description    TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_at     TIMESTAMPTZ,
    decided_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
    expires_at     TIMESTAMPTZ,
    payload        JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
    CHECK (
        (state = 'pending'  AND decided_at IS NULL AND decided_by IS NULL)
        OR (state IN ('approved', 'rejected') AND decided_at IS NOT NULL)
        OR state = 'expired'
    )
);

-- Backs the production Electric shape (ShapeApprovals) + list-pending query.
CREATE INDEX IF NOT EXISTS idx_approvals_repo_session_state_created
    ON approvals (repository_id, session_id, state, created_at DESC);
