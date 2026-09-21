package db

import "context"

// GetRepoGatewayByID loads a gateway for the authenticated relay path. The
// relay still verifies the gateway's operator token in constant time; the
// opaque id is routing data, not authorization.
func (q *Queries) GetRepoGatewayByID(ctx context.Context, id string) (RepoGateway, error) {
	const query = `
SELECT id, repository_id, user_id, workspace_id, vm_id, base_url, auth_token_hash,
       auth_token_ciphertext, status, last_activity_at, deleted_at, created_at, updated_at
FROM repo_gateways
WHERE id = $1 AND deleted_at IS NULL
`
	row := q.db.QueryRow(ctx, query, id)
	var gateway RepoGateway
	err := row.Scan(
		&gateway.ID,
		&gateway.RepositoryID,
		&gateway.UserID,
		&gateway.WorkspaceID,
		&gateway.VmID,
		&gateway.BaseUrl,
		&gateway.AuthTokenHash,
		&gateway.AuthTokenCiphertext,
		&gateway.Status,
		&gateway.LastActivityAt,
		&gateway.DeletedAt,
		&gateway.CreatedAt,
		&gateway.UpdatedAt,
	)
	return gateway, err
}

// ListActiveRepoGateways returns every live gateway row whose Microsandbox VM
// still honors its long-lived operator token ('running' or 'suspended' — a
// suspended VM resumes with the same token). Hand-written (not sqlc): it backs
// the repo-gateway access-revocation sweep, which re-validates each row's user
// against current repository permissions and tears down gateways whose user
// lost write access. 'starting' rows are excluded — their provision was
// authorized moments ago and is still in flight; they become 'running' (and
// sweepable) within minutes.
func (q *Queries) ListActiveRepoGateways(ctx context.Context) ([]RepoGateway, error) {
	rows, err := q.db.Query(ctx, `
SELECT id, repository_id, user_id, workspace_id, vm_id, base_url, auth_token_hash, auth_token_ciphertext, status, last_activity_at, deleted_at, created_at, updated_at
FROM repo_gateways
WHERE deleted_at IS NULL
  AND status IN ('running', 'suspended')
`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []RepoGateway
	for rows.Next() {
		var i RepoGateway
		if err := rows.Scan(
			&i.ID,
			&i.RepositoryID,
			&i.UserID,
			&i.WorkspaceID,
			&i.VmID,
			&i.BaseUrl,
			&i.AuthTokenHash,
			&i.AuthTokenCiphertext,
			&i.Status,
			&i.LastActivityAt,
			&i.DeletedAt,
			&i.CreatedAt,
			&i.UpdatedAt,
		); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}
