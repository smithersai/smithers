-- Counter, reaction-cleanup and cap triggers that db/schema.sql has always
-- carried but no migration ever created. Production is migration-built, so
-- repositories.num_stars/num_watches/num_forks/num_issues/num_closed_issues
-- and issues.comment_count stayed frozen at 0, deleted issues and comments
-- left orphan reactions rows, and the webhook and workspace caps had no
-- atomic backstop. Bodies are verbatim from db/schema.sql. Expand-only.

CREATE OR REPLACE FUNCTION maintain_repo_fork_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE repositories
        SET num_forks = num_forks + 1,
            updated_at = NOW()
        WHERE id = NEW.fork_id;
        RETURN NEW;
    END IF;
    UPDATE repositories
    SET num_forks = GREATEST(num_forks - 1, 0),
        updated_at = NOW()
    WHERE id = OLD.fork_id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_repositories_fork_count_inc
    AFTER INSERT ON repositories
    FOR EACH ROW
    WHEN (NEW.fork_id IS NOT NULL)
    EXECUTE FUNCTION maintain_repo_fork_count();

CREATE TRIGGER trg_repositories_fork_count_dec
    AFTER DELETE ON repositories
    FOR EACH ROW
    WHEN (OLD.fork_id IS NOT NULL)
    EXECUTE FUNCTION maintain_repo_fork_count();

CREATE OR REPLACE FUNCTION maintain_repo_issue_counts()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE repositories
        SET num_issues = num_issues + 1,
            num_closed_issues = num_closed_issues
                + CASE WHEN NEW.state <> 'open' THEN 1 ELSE 0 END,
            updated_at = NOW()
        WHERE id = NEW.repository_id;
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        UPDATE repositories
        SET num_closed_issues = GREATEST(
                num_closed_issues
                + CASE WHEN NEW.state <> 'open' THEN 1 ELSE 0 END
                - CASE WHEN OLD.state <> 'open' THEN 1 ELSE 0 END,
                0),
            updated_at = NOW()
        WHERE id = NEW.repository_id;
        RETURN NEW;
    END IF;
    UPDATE repositories
    SET num_issues = GREATEST(num_issues - 1, 0),
        num_closed_issues = GREATEST(num_closed_issues
            - CASE WHEN OLD.state <> 'open' THEN 1 ELSE 0 END, 0),
        updated_at = NOW()
    WHERE id = OLD.repository_id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_issues_repo_counts_ins
    AFTER INSERT ON issues
    FOR EACH ROW
    EXECUTE FUNCTION maintain_repo_issue_counts();

CREATE TRIGGER trg_issues_repo_counts_upd
    AFTER UPDATE ON issues
    FOR EACH ROW
    WHEN (OLD.state IS DISTINCT FROM NEW.state)
    EXECUTE FUNCTION maintain_repo_issue_counts();

CREATE TRIGGER trg_issues_repo_counts_del
    AFTER DELETE ON issues
    FOR EACH ROW
    EXECUTE FUNCTION maintain_repo_issue_counts();

CREATE OR REPLACE FUNCTION maintain_issue_comment_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE issues
        SET comment_count = comment_count + 1,
            updated_at = NOW()
        WHERE id = NEW.issue_id;
        RETURN NEW;
    END IF;
    UPDATE issues
    SET comment_count = GREATEST(comment_count - 1, 0),
        updated_at = NOW()
    WHERE id = OLD.issue_id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_issue_comments_count_ins
    AFTER INSERT ON issue_comments
    FOR EACH ROW
    EXECUTE FUNCTION maintain_issue_comment_count();

CREATE TRIGGER trg_issue_comments_count_del
    AFTER DELETE ON issue_comments
    FOR EACH ROW
    EXECUTE FUNCTION maintain_issue_comment_count();

CREATE OR REPLACE FUNCTION delete_reactions_for_target()
RETURNS TRIGGER AS $$
BEGIN
    DELETE FROM reactions
    WHERE target_type = TG_ARGV[0]
      AND target_id = OLD.id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_issues_delete_reactions
    AFTER DELETE ON issues
    FOR EACH ROW EXECUTE FUNCTION delete_reactions_for_target('issue');

CREATE TRIGGER trg_issue_comments_delete_reactions
    AFTER DELETE ON issue_comments
    FOR EACH ROW EXECUTE FUNCTION delete_reactions_for_target('issue_comment');

CREATE TRIGGER trg_landing_requests_delete_reactions
    AFTER DELETE ON landing_requests
    FOR EACH ROW EXECUTE FUNCTION delete_reactions_for_target('landing_request');

CREATE TRIGGER trg_landing_request_comments_delete_reactions
    AFTER DELETE ON landing_request_comments
    FOR EACH ROW EXECUTE FUNCTION delete_reactions_for_target('landing_comment');

CREATE OR REPLACE FUNCTION maintain_repo_star_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE repositories
        SET num_stars = num_stars + 1,
            updated_at = NOW()
        WHERE id = NEW.repository_id;
        RETURN NEW;
    END IF;
    UPDATE repositories
    SET num_stars = GREATEST(num_stars - 1, 0),
        updated_at = NOW()
    WHERE id = OLD.repository_id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_stars_count_ins
    AFTER INSERT ON stars
    FOR EACH ROW
    EXECUTE FUNCTION maintain_repo_star_count();

CREATE TRIGGER trg_stars_count_del
    AFTER DELETE ON stars
    FOR EACH ROW
    EXECUTE FUNCTION maintain_repo_star_count();

CREATE OR REPLACE FUNCTION maintain_repo_watch_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE repositories
        SET num_watches = num_watches + 1,
            updated_at = NOW()
        WHERE id = NEW.repository_id;
        RETURN NEW;
    END IF;
    UPDATE repositories
    SET num_watches = GREATEST(num_watches - 1, 0),
        updated_at = NOW()
    WHERE id = OLD.repository_id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_watches_count_ins
    AFTER INSERT ON watches
    FOR EACH ROW
    EXECUTE FUNCTION maintain_repo_watch_count();

CREATE TRIGGER trg_watches_count_del
    AFTER DELETE ON watches
    FOR EACH ROW
    EXECUTE FUNCTION maintain_repo_watch_count();

CREATE OR REPLACE FUNCTION enforce_webhook_repo_cap()
RETURNS TRIGGER AS $$
DECLARE
    hook_count BIGINT;
BEGIN
    PERFORM 1 FROM repositories WHERE id = NEW.repository_id FOR UPDATE;
    SELECT COUNT(*) INTO hook_count
    FROM webhooks
    WHERE repository_id = NEW.repository_id;
    IF hook_count >= 20 THEN
        RAISE EXCEPTION 'repository % already has the maximum of 20 webhooks', NEW.repository_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'webhooks_repo_cap';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_webhooks_repo_cap
    BEFORE INSERT ON webhooks
    FOR EACH ROW
    EXECUTE FUNCTION enforce_webhook_repo_cap();

CREATE OR REPLACE FUNCTION enforce_workspace_user_quota()
RETURNS TRIGGER AS $$
DECLARE
    active_count BIGINT;
BEGIN
    PERFORM 1 FROM users WHERE id = NEW.user_id FOR UPDATE;
    SELECT COUNT(*) INTO active_count
    FROM workspaces
    WHERE user_id = NEW.user_id
      AND deleted_at IS NULL
      AND status <> 'failed';
    IF active_count >= 100 THEN
        RAISE EXCEPTION 'user % already has the maximum of 100 active workspaces', NEW.user_id
            USING ERRCODE = 'check_violation', CONSTRAINT = 'workspaces_user_quota';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_workspaces_user_quota
    BEFORE INSERT ON workspaces
    FOR EACH ROW
    EXECUTE FUNCTION enforce_workspace_user_quota();

-- One-shot backfill: the counters are exact functions of their source rows.
UPDATE repositories AS r
SET num_stars = (SELECT COUNT(*) FROM stars s WHERE s.repository_id = r.id),
    num_watches = (SELECT COUNT(*) FROM watches w WHERE w.repository_id = r.id),
    num_forks = (SELECT COUNT(*) FROM repositories f WHERE f.fork_id = r.id),
    num_issues = (SELECT COUNT(*) FROM issues i WHERE i.repository_id = r.id),
    num_closed_issues = (SELECT COUNT(*) FROM issues i WHERE i.repository_id = r.id AND i.state <> 'open');

UPDATE issues AS i
SET comment_count = (SELECT COUNT(*) FROM issue_comments c WHERE c.issue_id = i.id);

DELETE FROM reactions AS x
WHERE (x.target_type = 'issue' AND NOT EXISTS (SELECT 1 FROM issues i WHERE i.id = x.target_id))
   OR (x.target_type = 'issue_comment' AND NOT EXISTS (SELECT 1 FROM issue_comments c WHERE c.id = x.target_id))
   OR (x.target_type = 'landing_request' AND NOT EXISTS (SELECT 1 FROM landing_requests l WHERE l.id = x.target_id))
   OR (x.target_type = 'landing_comment' AND NOT EXISTS (SELECT 1 FROM landing_request_comments c WHERE c.id = x.target_id));
