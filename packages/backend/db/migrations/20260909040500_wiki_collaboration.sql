-- The existing wiki rows remain the readable projection. Yjs state includes
-- pending causal updates; the revision stream supplies history and durable acks.
ALTER TABLE wiki_pages
    ADD COLUMN revision BIGINT NOT NULL DEFAULT 1,
    ADD COLUMN crdt_state BYTEA,
    ADD COLUMN crdt_vector BYTEA,
    ADD COLUMN last_update_id UUID,
    ADD COLUMN last_update BYTEA,
    ADD CONSTRAINT wiki_crdt_state_pair CHECK ((crdt_state IS NULL) = (crdt_vector IS NULL)),
    ADD CONSTRAINT wiki_crdt_state_size CHECK (octet_length(crdt_state) <= 8388608),
    ADD CONSTRAINT wiki_body_size CHECK (octet_length(body) <= 1048576) NOT VALID;

CREATE TABLE wiki_page_revisions (
    id BIGSERIAL PRIMARY KEY,
    repository_id BIGINT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    -- Retain history after deletion; page IDs are never reused on recreation.
    page_id BIGINT NOT NULL,
    revision BIGINT NOT NULL,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    author_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    author_username TEXT NOT NULL,
    update_id UUID,
    update_bytes BYTEA,
    deleted BOOLEAN NOT NULL DEFAULT FALSE,
    history_commit_id TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (page_id, revision),
    UNIQUE (page_id, update_id)
);
CREATE INDEX idx_wiki_page_revisions_repo ON wiki_page_revisions(repository_id, id);

INSERT INTO wiki_page_revisions(repository_id, page_id, revision, slug, title, body, author_id, author_username, created_at)
SELECT wp.repository_id, wp.id, wp.revision, wp.slug, wp.title, wp.body, wp.author_id, u.username, wp.updated_at
FROM wiki_pages wp JOIN users u ON u.id = wp.author_id;

CREATE FUNCTION wiki_advance_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- Initializing causal metadata is not a new human edit. The CAS query
    -- changes only these two fields and never changes author/time/body.
    IF OLD.crdt_state IS NULL AND NEW.crdt_state IS NOT NULL
       AND (to_jsonb(NEW) - 'crdt_state' - 'crdt_vector') =
           (to_jsonb(OLD) - 'crdt_state' - 'crdt_vector') THEN
        RETURN NEW;
    END IF;
    NEW.revision := OLD.revision + 1;
    RETURN NEW;
END $$;
CREATE TRIGGER wiki_advance_revision BEFORE UPDATE ON wiki_pages
FOR EACH ROW EXECUTE FUNCTION wiki_advance_revision();

CREATE FUNCTION wiki_record_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    page wiki_pages%ROWTYPE;
    cursor_id BIGINT;
    is_deleted BOOLEAN := TG_OP = 'DELETE';
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.revision = OLD.revision THEN
        RETURN NULL;
    END IF;
    IF is_deleted THEN
        -- Parent/user cascades have already removed the referenced row.
        -- Ordinary page deletion retains history; repository deletion removes it.
        IF NOT EXISTS (SELECT 1 FROM repositories WHERE id = OLD.repository_id) THEN
            RETURN NULL;
        END IF;
        page := OLD;
        page.revision := OLD.revision + 1;
        page.last_update_id := NULL;
        page.last_update := NULL;
        page.author_id := COALESCE(NULLIF(current_setting('smithers.wiki_actor_id', true), '')::bigint, OLD.author_id);
    ELSE
        page := NEW;
    END IF;
    INSERT INTO wiki_page_revisions(repository_id, page_id, revision, slug, title, body,
        author_id, author_username, update_id, update_bytes, deleted)
    VALUES (page.repository_id, page.id, page.revision, page.slug, page.title, page.body,
        CASE WHEN EXISTS (SELECT 1 FROM users WHERE id = page.author_id) THEN page.author_id END, COALESCE((SELECT username FROM users WHERE id = page.author_id), ''),
        page.last_update_id, page.last_update, is_deleted)
    RETURNING id INTO cursor_id;
    -- Only small metadata goes through NOTIFY; clients fetch bounded pages of
    -- committed revisions or the latest CRDT snapshot through authorized REST.
    PERFORM pg_notify('wiki_page_' || page.id, json_build_object(
        'id', page.revision, 'page_id', page.id, 'revision', page.revision,
        'update_id', page.last_update_id, 'deleted', is_deleted)::text);
    RETURN NULL;
END $$;
CREATE TRIGGER wiki_record_revision AFTER INSERT OR UPDATE OR DELETE ON wiki_pages
FOR EACH ROW EXECUTE FUNCTION wiki_record_revision();
