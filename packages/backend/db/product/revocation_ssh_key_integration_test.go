package product

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/database"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

// Migration 0017 must let the SSH-key revocation kind and its fingerprint
// survive a durable round trip, because a restarted SSH pod replays missed
// events from revocation_events rather than from NOTIFY.
func TestSSHKeyRevokedEventRoundTripsThroughRevocationEvents(t *testing.T) {
	raw := os.Getenv("SMITHERS_PRODUCT_TEST_DATABASE_URL")
	if raw == "" {
		if os.Getenv("SMITHERS_REQUIRE_DATABASE_TESTS") == "1" {
			t.Fatal("SMITHERS_PRODUCT_TEST_DATABASE_URL is required")
		}
		t.Skip("set SMITHERS_PRODUCT_TEST_DATABASE_URL for PostgreSQL integration test")
	}
	ctx := context.Background()
	adminURL, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	adminURL.Path = "/postgres"
	admin, err := pgx.Connect(ctx, adminURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	var random [8]byte
	if _, err := rand.Read(random[:]); err != nil {
		t.Fatal(err)
	}
	name := "smithers_revocation_" + hex.EncodeToString(random[:])
	if _, err := admin.Exec(ctx, `CREATE DATABASE "`+name+`"`); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := admin.Exec(ctx, `DROP DATABASE "`+name+`" WITH (FORCE)`); err != nil {
			t.Errorf("drop test database: %v", err)
		}
	}()
	dbURL := *adminURL
	dbURL.Path = "/" + name
	poolConfig, err := pgxpool.ParseConfig(dbURL.String())
	if err != nil {
		t.Fatal(err)
	}
	poolConfig.AfterConnect = func(_ context.Context, conn *pgx.Conn) error {
		database.ConfigureSQLCTypes(conn.TypeMap())
		return nil
	}
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := Apply(ctx, pool); err != nil {
		t.Fatalf("product migration: %v", err)
	}

	queries := db.New(pool)
	in := revocation.Event{
		Kind:           revocation.KindSSHKeyRevoked,
		RepositoryID:   5,
		KeyFingerprint: "SHA256:deploy-key",
		Reason:         "deploy key deleted",
	}
	row, err := queries.InsertRevocationEvent(ctx, in.ToParams())
	if err != nil {
		t.Fatalf("insert ssh_key_revoked: %v", err)
	}
	rows, err := queries.ListRevocationEventsAfter(ctx, db.ListRevocationEventsAfterParams{AfterID: row.ID - 1, LimitCount: 10})
	if err != nil || len(rows) != 1 {
		t.Fatalf("list events: rows=%d err=%v", len(rows), err)
	}
	out := revocation.FromRow(rows[0])
	if out.Kind != revocation.KindSSHKeyRevoked || out.KeyFingerprint != "SHA256:deploy-key" || out.RepositoryID != 5 {
		t.Fatalf("round trip lost data: %+v", out)
	}
	if !out.Affects(revocation.Principal{KeyFingerprint: "SHA256:deploy-key"}) {
		t.Fatal("replayed event must still close the session it names")
	}
	if _, err := pool.Exec(ctx, `INSERT INTO revocation_events (kind) VALUES ('not_a_kind')`); err == nil {
		t.Fatal("kind CHECK constraint must still reject unknown kinds")
	}
}
