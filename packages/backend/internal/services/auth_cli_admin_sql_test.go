package services

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/testutil/postgresfixture"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Exercise the generated CTE against PostgreSQL, including an audit failure.
// An isolated database applies the canonical schema, including token provenance.
func TestAdminCLITokenSQLAtomicAudit(t *testing.T) {
	databaseURL := os.Getenv("SMITHERS_TEST_ADMIN_CLI_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("SMITHERS_TEST_ADMIN_CLI_DATABASE_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	conn, _ := postgresfixture.NewProductDatabase(t, databaseURL)
	_, err := conn.Exec(ctx, `INSERT INTO users(id,username,lower_username,email,lower_email,display_name) VALUES (7,'operator','operator','operator@example.test','operator@example.test','Operator')`)
	require.NoError(t, err)
	q := db.New(conn)
	expires := time.Now().UTC().Add(time.Hour).Truncate(time.Microsecond)
	arg := db.CreateAdminCLIAccessTokenParams{UserID: 7, TokenHash: "hash-1", TokenLastEight: "hash0001", Scopes: "read:admin,write:admin", ExpiresAt: pgtype.Timestamptz{Time: expires, Valid: true}, ActorName: "operator", Metadata: []byte(`{"ttl":"1h0m0s","callback_port":4321,"ip":"127.0.0.1"}`), IpAddress: "127.0.0.1"}
	token, err := q.CreateAdminCLIAccessToken(ctx, arg)
	require.NoError(t, err)
	require.Equal(t, "smithers-cli-admin", token.Name)
	require.False(t, token.SystemIssued, "a human admin login retains ordinary user-token provenance")
	require.Equal(t, expires, token.ExpiresAt.Time.UTC())
	var event, actor, target, action, metadata, ip string
	var actorID, targetID int64
	err = conn.QueryRow(ctx, `SELECT event_type,actor_id,actor_name,target_id,target_name,action,metadata::text,ip_address FROM audit_log`).Scan(&event, &actorID, &actor, &targetID, &target, &action, &metadata, &ip)
	require.NoError(t, err)
	require.Equal(t, "auth.cli_admin_login", event)
	require.Equal(t, int64(7), actorID)
	require.Equal(t, token.ID, targetID)
	require.Equal(t, "operator", actor)
	require.Equal(t, token.Name, target)
	require.Equal(t, "login", action)
	require.JSONEq(t, string(arg.Metadata), metadata)
	require.Equal(t, arg.IpAddress, ip)
	_, err = conn.Exec(ctx, `ALTER TABLE audit_log ADD CONSTRAINT reject_new_audits CHECK (false) NOT VALID`)
	require.NoError(t, err)
	arg.TokenHash = "hash-2"
	_, err = q.CreateAdminCLIAccessToken(ctx, arg)
	require.Error(t, err)
	var count int
	require.NoError(t, conn.QueryRow(ctx, `SELECT count(*) FROM access_tokens`).Scan(&count))
	require.Equal(t, 1, count, "failed audit must roll back PAT insertion")
	require.NoError(t, conn.QueryRow(ctx, `SELECT count(*) FROM audit_log`).Scan(&count))
	require.Equal(t, 1, count)
}
