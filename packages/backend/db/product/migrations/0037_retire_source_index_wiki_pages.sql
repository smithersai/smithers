-- The per-folder source index (librarian/wiki, retired when 0036 added the mythical wiki)
-- published source-<commit>-<digest> wiki pages through the deleted gateway
-- route. The mythical wiki (generated-<id>) replaces them. Delete every such
-- page once; the wiki revision trigger records each deletion in the page's
-- history like any other delete (attributed to the page's author, as no actor
-- is set here). Running this again changes nothing.
--
-- A repository with a mythical stack records the count on its wiki row, and
-- every refresh receipt reports it (legacyPagesRemoved). A row created here
-- starts 'off'; the stack worker turns it on when main declares a wiki.
ALTER TABLE mythical_wikis ADD COLUMN IF NOT EXISTS legacy_pages_removed integer NOT NULL DEFAULT 0;

WITH removed AS (
    DELETE FROM wiki_pages
    WHERE slug ~ '^source-([0-9a-f]{40}|[0-9a-f]{64})-[0-9a-f]{16}$'
    RETURNING repository_id
), counted AS (
    SELECT removed.repository_id, count(*)::integer AS pages
    FROM removed
    JOIN mythical_stacks USING (repository_id)
    GROUP BY removed.repository_id
)
INSERT INTO mythical_wikis (repository_id, state, legacy_pages_removed)
SELECT repository_id, 'off', pages FROM counted
ON CONFLICT (repository_id) DO UPDATE
SET legacy_pages_removed = mythical_wikis.legacy_pages_removed + EXCLUDED.legacy_pages_removed;
