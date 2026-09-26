package product

import (
	"context"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

// Migration 0017 must let the SSH-key revocation kind and its fingerprint
// survive a durable round trip, because a restarted SSH pod replays missed
// events from revocation_events rather than from NOTIFY.
func TestSSHKeyRevokedEventRoundTripsThroughRevocationEvents(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
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
