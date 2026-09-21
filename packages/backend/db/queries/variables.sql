-- name: CreateOrUpdateVariable :one
INSERT INTO repository_variables (repository_id, name, value)
VALUES ($1, $2, $3)
ON CONFLICT (repository_id, name)
DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
RETURNING *;

-- name: GetVariableByName :one
SELECT * FROM repository_variables
WHERE repository_id = $1 AND name = $2;

-- name: ListVariables :many
SELECT * FROM repository_variables
WHERE repository_id = $1
ORDER BY name;

-- name: DeleteVariable :exec
DELETE FROM repository_variables
WHERE repository_id = $1 AND name = $2;

-- name: CreateOrUpdateOrgVariable :one
INSERT INTO organization_variables (organization_id, name, value)
VALUES ($1, $2, $3)
ON CONFLICT (organization_id, name)
DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
RETURNING *;

-- name: GetOrgVariableByName :one
SELECT * FROM organization_variables
WHERE organization_id = $1 AND name = $2;

-- name: ListOrgVariables :many
SELECT * FROM organization_variables
WHERE organization_id = $1
ORDER BY name;

-- name: DeleteOrgVariable :exec
DELETE FROM organization_variables
WHERE organization_id = $1 AND name = $2;
