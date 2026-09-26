package db

import (
	"context"
	"time"
)

// RecordWorkspaceProviderUse counts one model call of a workspace that a
// pooled account answered, under the model the call named.
func (q *Queries) RecordWorkspaceProviderUse(ctx context.Context, workspaceID, connectionID, model string) error {
	_, err := q.db.Exec(ctx, `INSERT INTO workspace_provider_uses (workspace_id, connection_id, model)
		VALUES ($1::uuid, $2::uuid, $3)
		ON CONFLICT (workspace_id, connection_id, model) DO UPDATE
		SET calls = workspace_provider_uses.calls + 1,
		    last_used_at = GREATEST(workspace_provider_uses.last_used_at, NOW())`,
		workspaceID, connectionID, model)
	return err
}

// WorkspaceProviderUse is what a workspace's pooled calls ran on: the
// account of its latest call, how many distinct accounts served it, and the
// model most of its calls named. It carries the account's public identity
// only (owner, provider, label, email), never credential material.
type WorkspaceProviderUse struct {
	WorkspaceID  string
	OwnerType    string
	OwnerUserID  int64
	Provider     string
	Label        string
	AccountEmail string
	LastUsedAt   time.Time
	Accounts     int64
	Model        string
}

// ListLatestWorkspaceProviderUses answers one row per workspace of
// workspaceIDs that has recorded calls.
func (q *Queries) ListLatestWorkspaceProviderUses(ctx context.Context, workspaceIDs []string) ([]WorkspaceProviderUse, error) {
	if len(workspaceIDs) == 0 {
		return nil, nil
	}
	rows, err := q.db.Query(ctx, `WITH latest AS (
			SELECT DISTINCT ON (u.workspace_id) u.workspace_id, u.connection_id, u.last_used_at
			FROM workspace_provider_uses u
			WHERE u.workspace_id = ANY($1::uuid[])
			ORDER BY u.workspace_id, u.last_used_at DESC, u.connection_id
		), accounts AS (
			SELECT workspace_id, count(DISTINCT connection_id) AS accounts
			FROM workspace_provider_uses
			WHERE workspace_id = ANY($1::uuid[])
			GROUP BY workspace_id
		), seat AS (
			SELECT DISTINCT ON (workspace_id) workspace_id, model
			FROM (SELECT workspace_id, model, sum(calls) AS calls, max(last_used_at) AS last_used_at
				FROM workspace_provider_uses
				WHERE workspace_id = ANY($1::uuid[]) AND model <> ''
				GROUP BY workspace_id, model) m
			ORDER BY workspace_id, calls DESC, last_used_at DESC, model
		)
		SELECT l.workspace_id::text, c.owner_type, COALESCE(c.user_id, 0), c.provider, c.label, c.account_email, l.last_used_at,
			a.accounts, COALESCE(s.model, '')
		FROM latest l
		JOIN provider_connections c ON c.id = l.connection_id
		JOIN accounts a ON a.workspace_id = l.workspace_id
		LEFT JOIN seat s ON s.workspace_id = l.workspace_id`, workspaceIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []WorkspaceProviderUse
	for rows.Next() {
		var use WorkspaceProviderUse
		if err := rows.Scan(&use.WorkspaceID, &use.OwnerType, &use.OwnerUserID, &use.Provider, &use.Label, &use.AccountEmail,
			&use.LastUsedAt, &use.Accounts, &use.Model); err != nil {
			return nil, err
		}
		out = append(out, use)
	}
	return out, rows.Err()
}
