-- Expand-only: one integer column, defaulted, no rewrite of existing rows.
-- Apply in one transaction.

-- Every sandbox create/fork a workspace issues carries an Idempotency-Key
-- derived from (action, resource kind, workspace id, attempt label). A
-- reprovision after a lost VM re-ran the SAME attempt label for the SAME
-- workspace id, so it presented the original create's key with a different
-- request body (fresh image/closure, fresh sandbox name) and the controller
-- answered 409 idempotency_conflict, stranding the workspace in 'failed'
-- forever. provisioning_generation is bumped once per reprovision attempt and
-- folded into the key, so each attempt gets its own logical operation while a
-- retry WITHIN an attempt still converges on one sandbox.
ALTER TABLE workspaces
    ADD COLUMN IF NOT EXISTS provisioning_generation INTEGER NOT NULL DEFAULT 0
        CONSTRAINT workspaces_provisioning_generation_check CHECK (provisioning_generation >= 0);
