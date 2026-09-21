-- Convert the legacy repo-host-backed wiki metadata table into a DB-backed page store.
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS body TEXT NOT NULL DEFAULT '';
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS author_id BIGINT REFERENCES users(id);

UPDATE wiki_pages
SET title = COALESCE(NULLIF(BTRIM(name), ''), 'Untitled ' || id::text)
WHERE title IS NULL OR title = '';

WITH base_slugs AS (
    SELECT
        id,
        COALESCE(
            NULLIF(BTRIM(REGEXP_REPLACE(LOWER(title), '[^a-z0-9]+', '-', 'g'), '-'), ''),
            'page'
        ) AS base_slug
    FROM wiki_pages
),
ranked_slugs AS (
    SELECT
        id,
        CASE
            WHEN ROW_NUMBER() OVER (PARTITION BY base_slug ORDER BY id) = 1 THEN base_slug
            ELSE base_slug || '-' || ROW_NUMBER() OVER (PARTITION BY base_slug ORDER BY id)
        END AS normalized_slug
    FROM base_slugs
)
UPDATE wiki_pages wp
SET slug = rs.normalized_slug
FROM ranked_slugs rs
WHERE wp.id = rs.id
  AND (wp.slug IS NULL OR wp.slug = '');

UPDATE wiki_pages wp
SET author_id = COALESCE(
    (
        SELECT wr.author_id
        FROM wiki_revisions wr
        WHERE wr.wiki_page_id = wp.id
          AND wr.author_id IS NOT NULL
        ORDER BY wr.created_at ASC, wr.id ASC
        LIMIT 1
    ),
    (
        SELECT r.user_id
        FROM repositories r
        WHERE r.id = wp.repository_id
          AND r.user_id IS NOT NULL
    ),
    (
        SELECT om.user_id
        FROM repositories r
        JOIN org_members om ON om.organization_id = r.org_id
        WHERE r.id = wp.repository_id
        ORDER BY CASE WHEN om.role = 'owner' THEN 0 ELSE 1 END, om.user_id ASC
        LIMIT 1
    ),
    (
        SELECT id
        FROM users
        ORDER BY id ASC
        LIMIT 1
    )
)
WHERE wp.author_id IS NULL;

ALTER TABLE wiki_pages DROP CONSTRAINT IF EXISTS wiki_pages_repository_id_name_key;
DROP INDEX IF EXISTS idx_wiki_pages_name;
DROP INDEX IF EXISTS idx_wiki_pages_repository_id;

ALTER TABLE wiki_pages DROP COLUMN IF EXISTS name;
ALTER TABLE wiki_pages DROP COLUMN IF EXISTS last_commit_sha;

ALTER TABLE wiki_pages ALTER COLUMN slug SET NOT NULL;
ALTER TABLE wiki_pages ALTER COLUMN title SET NOT NULL;
ALTER TABLE wiki_pages ALTER COLUMN author_id SET NOT NULL;

ALTER TABLE wiki_pages
    ADD CONSTRAINT wiki_pages_repository_id_slug_key UNIQUE (repository_id, slug);

CREATE INDEX IF NOT EXISTS idx_wiki_pages_repo ON wiki_pages(repository_id);

DROP TABLE IF EXISTS wiki_revisions;
