-- Revision: 20260904130000.
-- Durable landing recovery, search snapshots, revocation, and dependency guards.
CREATE TABLE code_search_index_state (
    repository_id BIGINT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
    commit_id TEXT NOT NULL
);
ALTER TABLE changesets ADD COLUMN landing_plan JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE revocation_events DROP CONSTRAINT revocation_events_kind_check;
ALTER TABLE revocation_events ADD CONSTRAINT revocation_events_kind_check CHECK (kind IN (
    'token_revoked', 'token_scopes_narrowed', 'user_disabled', 'user_enabled',
    'collaborator_removed', 'workspace_share_removed', 'agent_session_cancelled',
    'org_member_removed', 'gateway_revoked'
));

-- Token deletion, including cascading application deletion and bulk grant
-- removal, must revoke existing connections in the same transaction.
CREATE FUNCTION revoke_deleted_oauth2_token() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event revocation_events;
BEGIN
    PERFORM pg_advisory_xact_lock(1548769901);
    INSERT INTO revocation_events (kind, user_id, token_hash, reason)
    VALUES ('token_revoked', OLD.user_id, OLD.token_hash, 'OAuth token revoked')
    RETURNING * INTO event;
    PERFORM pg_notify('revocations', json_build_object('id', event.id, 'kind', event.kind,
        'user_id', event.user_id, 'token_hash', event.token_hash)::text);
    RETURN OLD;
END;
$$;
CREATE TRIGGER oauth2_token_revocation AFTER DELETE ON oauth2_access_tokens
FOR EACH ROW EXECUTE FUNCTION revoke_deleted_oauth2_token();

-- A transaction lock serializes edges within a repository; the reachability
-- query runs after that lock so opposite concurrent inserts cannot both pass.
CREATE FUNCTION enforce_issue_dependency_dag() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE repo_id bigint;
BEGIN
    SELECT repository_id INTO repo_id FROM issues WHERE id = NEW.issue_id;
    PERFORM pg_advisory_xact_lock(hashtextextended('issue_dependencies:' || repo_id::text, 0));
    IF EXISTS (
        WITH RECURSIVE reachable(id) AS (
            SELECT NEW.depends_on_issue_id
            UNION
            SELECT d.depends_on_issue_id FROM issue_dependencies d JOIN reachable r ON d.issue_id = r.id
        ) SELECT 1 FROM reachable WHERE id = NEW.issue_id
    ) THEN
        RAISE EXCEPTION 'issue dependency would create a cycle'
            USING ERRCODE = '23514', CONSTRAINT = 'issue_dependencies_acyclic';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER issue_dependency_dag BEFORE INSERT OR UPDATE ON issue_dependencies
FOR EACH ROW EXECUTE FUNCTION enforce_issue_dependency_dag();

-- Account state and its event commit together. Publishing after UPDATE could
-- reorder concurrent suspend/unsuspend calls or lose an event on process exit.
CREATE FUNCTION publish_user_access_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    event revocation_events;
    old_enabled boolean := OLD.is_active AND NOT OLD.prohibit_login AND OLD.deleted_at IS NULL;
    new_enabled boolean := NEW.is_active AND NOT NEW.prohibit_login AND NEW.deleted_at IS NULL;
BEGIN
    IF old_enabled IS NOT DISTINCT FROM new_enabled THEN
        RETURN NEW;
    END IF;
    PERFORM pg_advisory_xact_lock(1548769901);
    INSERT INTO revocation_events (kind, user_id, reason)
    VALUES (CASE WHEN new_enabled THEN 'user_enabled' ELSE 'user_disabled' END,
        NEW.id, CASE WHEN new_enabled THEN 'account enabled' ELSE 'account suspended or deleted' END)
    RETURNING * INTO event;
    PERFORM pg_notify('revocations', json_build_object('id', event.id, 'kind', event.kind,
        'user_id', event.user_id)::text);
    RETURN NEW;
END;
$$;
CREATE TRIGGER user_access_revocation AFTER UPDATE OF is_active, prohibit_login, deleted_at ON users
FOR EACH ROW EXECUTE FUNCTION publish_user_access_change();
