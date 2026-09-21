-- Expand-only notification journal. Execute as one migration transaction.
LOCK TABLE notifications IN SHARE ROW EXCLUSIVE MODE;

-- Notification lifecycle facts. The per-user head is updated under a lock;
-- unlike BIGSERIAL, this is a committed, gap-free position within this journal.
CREATE TABLE notification_journals (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    head BIGINT NOT NULL DEFAULT 0 CHECK (head >= 0),
    coverage_kind TEXT NOT NULL DEFAULT 'from_creation'
        CHECK (coverage_kind IN ('legacy_snapshot', 'from_creation')),
    coverage_started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE notification_facts (
    user_id BIGINT NOT NULL REFERENCES notification_journals(user_id) ON DELETE CASCADE,
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    event_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    schema_version SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version = 1),
    event_type TEXT NOT NULL CHECK (event_type IN (
        'notification.baseline', 'notification.created', 'notification.read',
        'notification.unread', 'notification.updated', 'notification.deleted'
    )),
    notification_id BIGINT NOT NULL,
    post_image JSONB NOT NULL CHECK (jsonb_typeof(post_image) = 'object'),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (user_id, sequence)
);
CREATE INDEX idx_notification_facts_notification ON notification_facts (user_id, notification_id, sequence);

-- Explicit snapshots preserve the current legacy rows and their timestamps.
-- They do not assert that original creation/read history is reconstructible.
INSERT INTO notification_journals (user_id, coverage_kind)
SELECT id, 'legacy_snapshot' FROM users;
INSERT INTO notification_facts (user_id, sequence, event_type, notification_id, post_image, recorded_at)
SELECT n.user_id, row_number() OVER (PARTITION BY n.user_id ORDER BY n.id),
       'notification.baseline', n.id, to_jsonb(n) - 'user_id', j.coverage_started_at
FROM notifications n JOIN notification_journals j ON j.user_id = n.user_id;
UPDATE notification_journals j
SET head = counts.total
FROM (SELECT user_id, COUNT(*) AS total FROM notification_facts GROUP BY user_id) counts
WHERE counts.user_id = j.user_id;

CREATE OR REPLACE FUNCTION lock_notification_journal()
RETURNS TRIGGER AS $$
DECLARE recipient BIGINT;
BEGIN
    IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id) THEN
        RAISE EXCEPTION 'notification identity is immutable' USING ERRCODE = '23514';
    END IF;
    recipient := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
    -- Match the existing creation query lock order: user, then journal. All
    -- service update queries also lock this user before touching child rows.
    -- On a user FK cascade the user is already absent, so no fact is retained.
    PERFORM users.id FROM users WHERE users.id = recipient FOR UPDATE;
    IF FOUND THEN
        INSERT INTO notification_journals (user_id) VALUES (recipient)
        ON CONFLICT (user_id) DO NOTHING;
        PERFORM user_id FROM notification_journals WHERE user_id = recipient FOR UPDATE;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION record_notification_fact()
RETURNS TRIGGER AS $$
DECLARE
    recipient BIGINT;
    record_id BIGINT;
    position BIGINT;
    kind TEXT;
    image JSONB;
BEGIN
    recipient := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
    IF NOT EXISTS (SELECT 1 FROM users WHERE users.id = recipient) THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND to_jsonb(NEW) = to_jsonb(OLD) THEN RETURN NEW; END IF;
    IF TG_OP = 'DELETE' THEN
        record_id := OLD.id;
        image := to_jsonb(OLD) - 'user_id';
        kind := 'notification.deleted';
    ELSE
        record_id := NEW.id;
        image := to_jsonb(NEW) - 'user_id';
        IF TG_OP = 'INSERT' THEN kind := 'notification.created';
        ELSIF NEW.status = 'read' AND (OLD.status <> NEW.status OR OLD.read_at IS DISTINCT FROM NEW.read_at) THEN kind := 'notification.read';
        ELSIF NEW.status = 'unread' AND OLD.status <> NEW.status THEN kind := 'notification.unread';
        ELSE kind := 'notification.updated';
        END IF;
    END IF;
    -- The BEFORE trigger holds user/journal locks before allocating this
    -- position; both head and fact disappear if this mutation rolls back.
    UPDATE notification_journals SET head = head + 1 WHERE user_id = recipient
    RETURNING head INTO STRICT position;
    INSERT INTO notification_facts (user_id, sequence, event_type, notification_id, post_image)
    VALUES (recipient, position, kind, record_id, image);
    -- PostgreSQL delivers this only after the surrounding mutation commits.
    PERFORM pg_notify('notification_facts_' || recipient::text, position::text);
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guard_notification_fact_history()
RETURNS TRIGGER AS $$
BEGIN
    -- Deleting a recipient must delete their private journal without an
    -- append-only guard breaking FK cascades or retaining personal snippets.
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM users WHERE users.id = OLD.user_id) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'notification facts are append-only' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notifications_journal_lock
    BEFORE INSERT OR UPDATE OR DELETE ON notifications
    FOR EACH ROW EXECUTE FUNCTION lock_notification_journal();
CREATE TRIGGER trg_notifications_record_fact
    AFTER INSERT OR UPDATE OR DELETE ON notifications
    FOR EACH ROW EXECUTE FUNCTION record_notification_fact();
CREATE TRIGGER trg_notification_facts_immutable
    BEFORE UPDATE OR DELETE ON notification_facts
    FOR EACH ROW EXECUTE FUNCTION guard_notification_fact_history();
