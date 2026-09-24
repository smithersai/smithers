package db

import (
	"context"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/testutil/postgresfixture"
	"github.com/stretchr/testify/require"
	"os"
	"testing"
	"time"
)

func TestAdminNeverStartedQueryGuardsAndPreservesMetadata(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t, resolveDBTestDatabaseURL(os.Getenv))
	ctx := context.Background()
	var userID, repoID int64
	err := pool.QueryRow(ctx, `INSERT INTO users(username,lower_username,email,lower_email,display_name) VALUES ('sessionowner','sessionowner','sessionowner@example.test','sessionowner@example.test','Session owner') RETURNING id`).Scan(&userID)
	require.NoError(t, err)
	err = pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name,is_public,default_bookmark) VALUES ($1,'sessionrepo','sessionrepo',false,'main') RETURNING id`, userID).Scan(&repoID)
	require.NoError(t, err)
	ids := []string{"11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"}
	for _, id := range ids {
		_, err = pool.Exec(ctx, `INSERT INTO agent_sessions(id,repository_id,user_id,status,metadata,created_at) VALUES ($1,$2,$3,'active','{"keep":"value"}',now()-interval '2 hours')`, id, repoID, userID)
		require.NoError(t, err)
	}
	_, err = pool.Exec(ctx, `UPDATE agent_sessions SET started_at=now() WHERE id=$1`, ids[1])
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE agent_sessions SET created_at=now() WHERE id=$1`, ids[2])
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE agent_sessions SET deleted_at=now() WHERE id=$1`, ids[3])
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE agent_sessions SET status='completed' WHERE id=$1`, ids[4])
	require.NoError(t, err)
	q := New(pool)
	cutoff := time.Now().UTC().Add(-time.Hour)
	rows, err := q.ListNeverStartedAgentSessions(ctx, cutoff)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, ids[0], rows[0].ID)
	// A runner starts after listing but before the update; it must win.
	_, err = pool.Exec(ctx, `UPDATE agent_sessions SET started_at=now() WHERE id=$1`, ids[0])
	require.NoError(t, err)
	_, err = q.FailNeverStartedAgentSession(ctx, FailNeverStartedAgentSessionParams{ID: ids[0], Cutoff: cutoff})
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = pool.Exec(ctx, `UPDATE agent_sessions SET started_at=NULL WHERE id=$1`, ids[0])
	require.NoError(t, err)
	failed, err := q.FailNeverStartedAgentSession(ctx, FailNeverStartedAgentSessionParams{ID: ids[0], Cutoff: cutoff})
	require.NoError(t, err)
	require.Equal(t, "failed", failed.Status)
	require.True(t, failed.FinishedAt.Valid)
	require.JSONEq(t, `{"keep":"value","failure_reason":"never_started"}`, string(failed.Metadata))
	_, err = q.FailNeverStartedAgentSession(ctx, FailNeverStartedAgentSessionParams{ID: ids[0], Cutoff: cutoff})
	require.ErrorIs(t, err, pgx.ErrNoRows)
}
