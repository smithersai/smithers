-- A developer-UID gateway cannot protect its operator token from a write-share
-- shell in the same VM. Serialize both admission paths on the existing workspace
-- row until shared execution has an authenticated initiating-actor boundary.
CREATE OR REPLACE FUNCTION guard_workspace_gateway_sharing()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bound_workspace uuid;
BEGIN
    IF TG_TABLE_NAME = 'repo_gateways' THEN
        IF NEW.workspace_id IS NULL OR NEW.deleted_at IS NOT NULL
           OR NEW.status IN ('stopped', 'failed') THEN RETURN NEW; END IF;
        bound_workspace := NEW.workspace_id;
        PERFORM 1 FROM workspaces WHERE id = bound_workspace FOR UPDATE;
        IF EXISTS (SELECT 1 FROM workspace_shares WHERE workspace_id = bound_workspace AND level = 'write') THEN
            RAISE EXCEPTION 'workspace coding gateway conflicts with write sharing'
                USING ERRCODE = '23514', CONSTRAINT = 'workspace_gateway_private_execution';
        END IF;
    ELSE
        IF NEW.level <> 'write' THEN RETURN NEW; END IF;
        bound_workspace := NEW.workspace_id;
        PERFORM 1 FROM workspaces WHERE id = bound_workspace FOR UPDATE;
        IF EXISTS (SELECT 1 FROM repo_gateways WHERE workspace_id = bound_workspace
                   AND (auth_token_hash <> '' OR (deleted_at IS NULL AND status NOT IN ('stopped', 'failed')))) THEN
            RAISE EXCEPTION 'workspace write sharing conflicts with coding gateway'
                USING ERRCODE = '23514', CONSTRAINT = 'workspace_gateway_private_execution';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_repo_gateways_private_execution
BEFORE INSERT OR UPDATE OF workspace_id, status, deleted_at ON repo_gateways
FOR EACH ROW EXECUTE FUNCTION guard_workspace_gateway_sharing();

CREATE TRIGGER trg_workspace_shares_private_execution
BEFORE INSERT OR UPDATE OF workspace_id, level ON workspace_shares
FOR EACH ROW EXECUTE FUNCTION guard_workspace_gateway_sharing();
