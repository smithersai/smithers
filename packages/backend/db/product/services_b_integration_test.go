package product

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestServicesBProviderRefreshClaimsAndFences(t *testing.T) {
	p := servicesBDatabase(t, 0)
	servicesBRepo(t, p)
	ctx := context.Background()
	q := db.New(p)
	row, err := q.CreateProviderConnection(ctx, db.CreateProviderConnectionParams{OwnerType: "user", UserID: pgtype.Int8{Int64: 1, Valid: true}, Provider: "codex", Kind: "oauth", AccessTokenEncrypted: []byte("old"), RefreshTokenEncrypted: []byte("refresh")})
	require.NoError(t, err)
	claim := db.ClaimProviderConnectionForRefreshParams{ExpiresBefore: time.Now().Add(time.Hour), LeaseUntil: time.Now().Add(time.Minute)}
	first, err := q.ClaimProviderConnectionForRefresh(ctx, claim)
	require.NoError(t, err)
	require.Equal(t, row.ID, first.ID)
	claim.ConnectionID = row.ID
	_, err = q.ClaimProviderConnectionForRefresh(ctx, claim)
	require.ErrorIs(t, err, pgx.ErrNoRows)
	_, err = p.Exec(ctx, "UPDATE provider_connections SET refresh_lease_until = NOW() - interval '1 second' WHERE id=$1", row.ID)
	require.NoError(t, err)
	second, err := q.ClaimProviderConnectionForRefresh(ctx, claim)
	require.NoError(t, err)
	require.Greater(t, second.RefreshGeneration, first.RefreshGeneration)
	require.NoError(t, q.UpdateProviderConnectionTokens(ctx, db.UpdateProviderConnectionTokensParams{ID: row.ID, RefreshGeneration: second.RefreshGeneration, AccessTokenEncrypted: []byte("new"), RefreshTokenEncrypted: []byte("rotated")}))
	require.NoError(t, q.MarkProviderConnectionRefreshFailure(ctx, db.MarkProviderConnectionRefreshFailureParams{ID: row.ID, RefreshGeneration: first.RefreshGeneration, State: "revoked", LastError: "invalid_grant"}))
	require.NoError(t, q.UpdateProviderConnectionTokens(ctx, db.UpdateProviderConnectionTokensParams{ID: row.ID, RefreshGeneration: first.RefreshGeneration, AccessTokenEncrypted: []byte("stale")}))
	current, err := q.GetProviderConnection(ctx, row.ID)
	require.NoError(t, err)
	require.Equal(t, "active", current.State)
	require.Equal(t, []byte("new"), current.AccessTokenEncrypted)
	require.Equal(t, []byte("rotated"), current.RefreshTokenEncrypted)
}

func TestServicesBMentionBackfillUsesUnambiguousContext(t *testing.T) {
	p := servicesBDatabase(t, 15)
	repo := servicesBRepo(t, p)
	ctx := context.Background()
	// Independent source sequences overlap; only the mention context is evidence.
	_, err := p.Exec(ctx, `INSERT INTO issues(id,repository_id,number,title,author_id) VALUES(7,$1,7,'issue',1)`, repo)
	require.NoError(t, err)
	_, err = p.Exec(ctx, `INSERT INTO landing_requests(id,repository_id,number,title,author_id,target_bookmark) VALUES(7,$1,7,'landing',1,'main')`, repo)
	require.NoError(t, err)
	_, err = p.Exec(ctx, `INSERT INTO mentions(repository_id,issue_id,comment_type,mentioned_user_id) VALUES($1,7,'issue_body',2),($1,7,'issue_body',3)`, repo)
	require.NoError(t, err)
	_, err = p.Exec(ctx, `INSERT INTO mentions(repository_id,landing_request_id,comment_type,mentioned_user_id) VALUES($1,7,'landing_body',3)`, repo)
	require.NoError(t, err)
	_, err = p.Exec(ctx, `INSERT INTO notifications(user_id,source_type,source_id) VALUES(2,'mention',7),(3,'mention',7),(1,'mention',7)`)
	require.NoError(t, err)
	require.NoError(t, Apply(ctx, p))
	for user, want := range map[int64]string{2: "mention_issue", 3: "mention", 1: "mention"} {
		var got string
		require.NoError(t, p.QueryRow(ctx, "SELECT source_type FROM notifications WHERE user_id=$1", user).Scan(&got))
		require.Equal(t, want, got)
	}
}

func servicesBDatabase(t *testing.T, version int) *pgxpool.Pool {
	t.Helper()
	pool := newProductTestPool(t)
	ctx := context.Background()
	specs, err := registeredMigrations()
	require.NoError(t, err)
	if version > 0 {
		specs = specs[:version]
	}
	require.NoError(t, applyOnce(ctx, pool, specs))
	return pool
}
func servicesBRepo(t *testing.T, p *pgxpool.Pool) int64 {
	t.Helper()
	_, err := p.Exec(t.Context(), `INSERT INTO users(id,username,lower_username) VALUES(1,'alice','alice'),(2,'bob','bob'),(3,'carol','carol')`)
	require.NoError(t, err)
	var id int64
	require.NoError(t, p.QueryRow(t.Context(), `INSERT INTO repositories(user_id,name,lower_name) VALUES(1,'services-b','services-b') RETURNING id`).Scan(&id))
	return id
}
