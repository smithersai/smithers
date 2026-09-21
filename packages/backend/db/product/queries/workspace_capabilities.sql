-- name: LockWorkspaceCapability :exec
SELECT pg_advisory_xact_lock(hashtextextended('workspace-capability:' || sqlc.arg(repository_id)::bigint::text || ':' || sqlc.arg(user_id)::bigint::text,0));

-- name: GetWorkspaceCapability :one
SELECT w.* FROM workspace_capability_bindings b JOIN workspaces w ON w.id=b.workspace_id
WHERE b.repository_id=$1 AND b.user_id=$2 AND b.required_capability=$3
FOR SHARE OF b;

-- name: BindWorkspaceCapability :exec
INSERT INTO workspace_capability_bindings(repository_id,user_id,required_capability,workspace_id)
SELECT $1,$2,$3,w.id FROM workspaces w
WHERE w.id=sqlc.arg(workspace_id)::uuid AND w.repository_id=$1 AND w.user_id=$2 AND w.deleted_at IS NULL;

-- name: ListRegisteredJobWorkspaceIDs :many
SELECT DISTINCT workspace_id FROM repository_job_registrations WHERE repository_id=$1 AND user_id=$2;
