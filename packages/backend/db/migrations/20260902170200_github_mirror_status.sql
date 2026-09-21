-- Persist the outcome of the GitHub push mirror on the Smithers repository so
-- repository API responses can render sync health without consulting the
-- github-sync worker's local SQLite database.

ALTER TABLE repositories
    ADD COLUMN mirror_status VARCHAR(16) NOT NULL DEFAULT 'unconfigured'
        CHECK (mirror_status IN ('synced', 'behind', 'failed', 'unconfigured')),
    ADD COLUMN last_mirror_at TIMESTAMPTZ,
    ADD COLUMN last_mirror_error TEXT,
    ADD COLUMN last_mirror_github_head VARCHAR(64);

-- Existing registry-backed mirrors have not reported a run through the new
-- API yet. Mark them behind instead of incorrectly presenting them as absent.
UPDATE repositories r
SET mirror_status = 'behind'
FROM owner_namespaces ns
WHERE (
      (ns.owner_type = 'user' AND ns.user_id = r.user_id)
      OR
      (ns.owner_type = 'org' AND ns.org_id = r.org_id)
  )
  AND EXISTS (
      SELECT 1
      FROM github_synced_repos g
      WHERE g.sync_refs
        AND g.sync_state <> 'disabled'
        AND LOWER(g.mirror_owner) = ns.lower_slug
        AND LOWER(g.mirror_repo) = r.lower_name
  );
