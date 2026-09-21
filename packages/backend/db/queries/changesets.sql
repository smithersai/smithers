-- name: CreateChangeset :one
INSERT INTO changesets (organization_id, superproject_repository_id, change_id, commit_id, parent_change_ids, target_bookmark, description, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING *;

-- name: AddChangesetMember :one
INSERT INTO changeset_members (changeset_id, repository_id, path, change_id, commit_id, target_bookmark)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: GetChangesetByID :one
SELECT *
FROM changesets
WHERE id = $1;

-- name: GetChangesetByOrgAndID :one
SELECT *
FROM changesets
WHERE organization_id = $1
  AND id = $2;

-- name: GetLandedChangesetForChange :one
SELECT cs.*
FROM changesets AS cs
WHERE cs.state = 'landed'
  AND (
    (cs.superproject_repository_id = sqlc.arg(repository_id)
      AND cs.change_id = sqlc.arg(change_id))
    OR EXISTS (
      SELECT 1
      FROM changeset_members AS member
      WHERE member.changeset_id = cs.id
        AND member.repository_id = sqlc.arg(repository_id)
        AND member.change_id = sqlc.arg(change_id)
    )
  )
ORDER BY cs.landed_at DESC, cs.id DESC
LIMIT 1;

-- name: ListChangesetMembers :many
SELECT *
FROM changeset_members
WHERE changeset_id = $1
ORDER BY path ASC;

-- name: ListChangesetsByOrg :many
SELECT *
FROM changesets
WHERE organization_id = $1
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg(page_size)
OFFSET sqlc.arg(page_offset);

-- name: MarkChangesetLanding :one
UPDATE changesets
SET state = 'landing', failure_reason = '', updated_at = NOW()
WHERE id = $1
  AND state IN ('pending', 'failed')
RETURNING *;

-- name: MarkChangesetLanded :one
UPDATE changesets
SET state = 'landed', failure_reason = '', landed_commit_id = $2, landed_at = NOW(), updated_at = NOW()
WHERE id = $1
RETURNING *;

-- name: MarkChangesetFailed :one
UPDATE changesets
SET state = 'failed', failure_reason = $2, updated_at = NOW()
WHERE id = $1
RETURNING *;

-- name: RecordChangesetMemberPreviousCommit :exec
UPDATE changeset_members
SET previous_commit_id = $2, updated_at = NOW()
WHERE id = $1;

-- name: RecordChangesetMemberLanded :exec
UPDATE changeset_members
SET landed_commit_id = $2, updated_at = NOW()
WHERE id = $1;

-- name: ClearChangesetMemberLanded :exec
UPDATE changeset_members
SET landed_commit_id = '', updated_at = NOW()
WHERE changeset_id = $1;

-- name: CreateChangesetWithMembers :one
WITH created AS (
    INSERT INTO changesets (organization_id, superproject_repository_id, change_id, commit_id, parent_change_ids, target_bookmark, description, created_by)
    VALUES (sqlc.arg(organization_id), sqlc.arg(superproject_repository_id), sqlc.arg(change_id), sqlc.arg(commit_id), sqlc.arg(parent_change_ids), sqlc.arg(target_bookmark), sqlc.arg(description), sqlc.narg(created_by))
    RETURNING *
), members AS (
    INSERT INTO changeset_members (changeset_id, repository_id, path, change_id, commit_id, target_bookmark)
    SELECT created.id, m.repository_id, m.path, m.change_id, m.commit_id, m.target_bookmark
    FROM created CROSS JOIN jsonb_to_recordset(sqlc.arg(members)::jsonb)
        AS m(repository_id bigint, path text, change_id text, commit_id text, target_bookmark text)
    RETURNING id
)
SELECT created.* FROM created;

-- name: SaveChangesetLandingPlan :one
UPDATE changesets
SET state = sqlc.arg(state), landing_plan = sqlc.arg(landing_plan), failure_reason = sqlc.arg(failure_reason), updated_at = NOW()
WHERE id = sqlc.arg(id)
RETURNING *;
