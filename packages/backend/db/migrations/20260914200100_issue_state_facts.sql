-- Expand-only journal; apply this complete migration in one transaction.
LOCK TABLE repositories, issues, issue_labels, issue_assignees IN SHARE ROW EXCLUSIVE MODE;

-- Accepted issue rows and membership rows, distinct from the presentation timeline.
CREATE TABLE issue_state_journals (
    repository_id BIGINT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
    head BIGINT NOT NULL DEFAULT 0 CHECK (head >= 0),
    coverage_kind TEXT NOT NULL DEFAULT 'from_creation' CHECK (coverage_kind IN ('legacy_snapshot', 'from_creation')),
    coverage_started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE issue_state_facts (
    repository_id BIGINT NOT NULL REFERENCES issue_state_journals(repository_id) ON DELETE CASCADE,
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    event_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    schema_version SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version = 1),
    entity_type TEXT NOT NULL CHECK (entity_type IN ('issue', 'issue_label', 'issue_assignee')),
    operation TEXT NOT NULL CHECK (operation IN ('baseline', 'created', 'updated', 'deleted')),
    issue_id BIGINT NOT NULL,
    entity_key TEXT NOT NULL,
    post_image JSONB CHECK (post_image IS NULL OR jsonb_typeof(post_image) = 'object'),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (repository_id, sequence),
    CHECK ((operation = 'deleted' AND post_image IS NULL) OR (operation <> 'deleted' AND post_image IS NOT NULL))
);
CREATE INDEX idx_issue_state_facts_issue ON issue_state_facts (repository_id, issue_id, sequence);

-- Legacy snapshots preserve only currently retained rows, not prior transitions.
INSERT INTO issue_state_journals(repository_id, coverage_kind)
SELECT id, 'legacy_snapshot' FROM repositories;
WITH images AS (
    SELECT i.repository_id, i.id AS issue_id, 'issue'::TEXT AS entity_type, i.id::TEXT AS entity_key,
           to_jsonb(i) - 'search_vector' AS post_image, 0 AS entity_order
    FROM issues i
    UNION ALL
    SELECT i.repository_id, il.issue_id, 'issue_label', il.issue_id::TEXT || ':' || il.label_id::TEXT, to_jsonb(il), 1
    FROM issue_labels il JOIN issues i ON i.id = il.issue_id
    UNION ALL
    SELECT i.repository_id, ia.issue_id, 'issue_assignee', ia.id::TEXT, to_jsonb(ia), 2
    FROM issue_assignees ia JOIN issues i ON i.id = ia.issue_id
)
INSERT INTO issue_state_facts(repository_id, sequence, entity_type, operation, issue_id, entity_key, post_image, recorded_at)
SELECT images.repository_id, row_number() OVER(PARTITION BY images.repository_id ORDER BY issue_id, entity_order, entity_key),
       entity_type, 'baseline', issue_id, entity_key, post_image, j.coverage_started_at
FROM images JOIN issue_state_journals j ON j.repository_id = images.repository_id;
UPDATE issue_state_journals j SET head = counts.total
FROM (SELECT repository_id, COUNT(*) total FROM issue_state_facts GROUP BY repository_id) counts
WHERE counts.repository_id = j.repository_id;

CREATE OR REPLACE FUNCTION lock_issue_state_journal()
RETURNS TRIGGER AS $$
DECLARE repo BIGINT; parent_issue BIGINT;
BEGIN
    IF TG_TABLE_NAME = 'issues' THEN
        IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.repository_id <> OLD.repository_id OR NEW.number <> OLD.number) THEN
            RAISE EXCEPTION 'issue identity is immutable' USING ERRCODE = '23514';
        END IF;
        repo := CASE WHEN TG_OP = 'DELETE' THEN OLD.repository_id ELSE NEW.repository_id END;
    ELSE
        IF TG_OP = 'UPDATE' AND NEW.issue_id <> OLD.issue_id THEN
            RAISE EXCEPTION 'issue membership parent is immutable' USING ERRCODE = '23514';
        END IF;
        IF TG_OP = 'UPDATE' THEN
            IF TG_TABLE_NAME = 'issue_assignees' THEN
                IF NEW.id <> OLD.id THEN
                    RAISE EXCEPTION 'issue assignment identity is immutable' USING ERRCODE = '23514';
                END IF;
            ELSE
                IF NEW.label_id <> OLD.label_id THEN
                    RAISE EXCEPTION 'issue label identity is immutable' USING ERRCODE = '23514';
                END IF;
            END IF;
        END IF;
        parent_issue := CASE WHEN TG_OP = 'DELETE' THEN OLD.issue_id ELSE NEW.issue_id END;
        SELECT repository_id INTO repo FROM issues WHERE id = parent_issue;
    END IF;
    -- Match issue-number allocation and repository issue-count triggers. The
    -- journal counter is allocated only after both locks have been acquired.
    PERFORM id FROM repositories WHERE id = repo FOR UPDATE;
    IF FOUND THEN
        INSERT INTO issue_state_journals(repository_id) VALUES(repo) ON CONFLICT DO NOTHING;
        PERFORM repository_id FROM issue_state_journals WHERE repository_id = repo FOR UPDATE;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION record_issue_state_fact()
RETURNS TRIGGER AS $$
DECLARE repo BIGINT; parent_issue BIGINT; position BIGINT; entity TEXT; identity TEXT; image JSONB;
BEGIN
    IF TG_OP = 'UPDATE' AND to_jsonb(NEW) = to_jsonb(OLD) THEN RETURN NEW; END IF;
    image := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
    IF TG_TABLE_NAME = 'issues' THEN
        repo := (image ->> 'repository_id')::BIGINT;
        parent_issue := (image ->> 'id')::BIGINT;
        entity := 'issue'; identity := parent_issue::TEXT;
        image := image - 'search_vector';
        IF TG_OP = 'UPDATE' AND image = to_jsonb(OLD) - 'search_vector' THEN RETURN NEW; END IF;
    ELSE
        parent_issue := (image ->> 'issue_id')::BIGINT;
        SELECT repository_id INTO repo FROM issues WHERE id = parent_issue;
        IF TG_TABLE_NAME = 'issue_labels' THEN
            entity := 'issue_label'; identity := parent_issue::TEXT || ':' || (image ->> 'label_id');
        ELSE
            entity := 'issue_assignee'; identity := image ->> 'id';
        END IF;
    END IF;
    -- An issue delete fact removes all its memberships during projection.
    -- Cascading child deletion sees no issue; repository deletion purges its
    -- complete private history instead of appending an orphan tombstone.
    IF repo IS NULL OR NOT EXISTS (SELECT 1 FROM repositories WHERE id = repo) THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;
    UPDATE issue_state_journals SET head = head + 1 WHERE repository_id = repo RETURNING head INTO STRICT position;
    INSERT INTO issue_state_facts(repository_id, sequence, entity_type, operation, issue_id, entity_key, post_image)
    VALUES(repo, position, entity, CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'UPDATE' THEN 'updated' ELSE 'deleted' END,
        parent_issue, identity, CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE image END);
    PERFORM pg_notify('issue_state_facts_' || repo::TEXT, position::TEXT);
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guard_issue_state_fact_history()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM repositories WHERE id = OLD.repository_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'issue state facts are append-only' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_issues_journal_lock BEFORE INSERT OR UPDATE OR DELETE ON issues
    FOR EACH ROW EXECUTE FUNCTION lock_issue_state_journal();
CREATE TRIGGER trg_issues_record_fact AFTER INSERT OR UPDATE OR DELETE ON issues
    FOR EACH ROW EXECUTE FUNCTION record_issue_state_fact();
CREATE TRIGGER trg_issue_labels_journal_lock BEFORE INSERT OR UPDATE OR DELETE ON issue_labels
    FOR EACH ROW EXECUTE FUNCTION lock_issue_state_journal();
CREATE TRIGGER trg_issue_labels_record_fact AFTER INSERT OR UPDATE OR DELETE ON issue_labels
    FOR EACH ROW EXECUTE FUNCTION record_issue_state_fact();
CREATE TRIGGER trg_issue_assignees_journal_lock BEFORE INSERT OR UPDATE OR DELETE ON issue_assignees
    FOR EACH ROW EXECUTE FUNCTION lock_issue_state_journal();
CREATE TRIGGER trg_issue_assignees_record_fact AFTER INSERT OR UPDATE OR DELETE ON issue_assignees
    FOR EACH ROW EXECUTE FUNCTION record_issue_state_fact();
CREATE TRIGGER trg_issue_state_facts_immutable BEFORE UPDATE OR DELETE ON issue_state_facts
    FOR EACH ROW EXECUTE FUNCTION guard_issue_state_fact_history();
