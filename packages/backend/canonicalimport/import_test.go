package canonicalimport

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

func archive() []Row {
	return []Row{
		{Kind: "users", SourceID: "identity:account:42", Fields: []byte(`{"id":42,"username":"legacy42","lower_username":"legacy42","email":"legacy@example.test","lower_email":"legacy@example.test","created_at":"2026-08-01T10:00:00Z"}`)},
		{Kind: "owner_model_credentials", SourceID: "vault:42:anthropic", Fields: []byte(`{"user_id":42,"name":"ANTHROPIC_API_KEY","origin":"import","value_encrypted":"canonical-ciphertext"}`)},
		{Kind: "oauth_accounts", SourceID: "identity:oauth:42", Fields: []byte(`{"id":77,"user_id":42,"provider":"github","provider_user_id":"123"}`)},
		{Kind: "chat_turns", SourceID: "turns:42:run-42", Fields: []byte(`{"id":"turn-42","user_id":42,"run_id":"run-42","leg_id":"0","request_hash":"req","access_hash":"access","state":"completed","terminal":true}`)},
	}
}

func TestCanonicalImportReplayVerifyAndConflicts(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	i := Importer{DB: pool}
	ctx := context.Background()
	rows := archive()

	dry, err := i.DryRun(rows)
	if err != nil || dry.Count != 4 || dry.Counts["oauth_accounts"] != 1 {
		t.Fatalf("dry=%+v err=%v", dry, err)
	}
	var wg sync.WaitGroup
	errs := make([]error, 3)
	for n := range errs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, errs[n] = i.Apply(ctx, rows)
		}()
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	checked, err := i.Verify(ctx, rows)
	if err != nil || checked.Checksum != dry.Checksum {
		t.Fatalf("verify=%+v err=%v", checked, err)
	}
	var receipts int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM canonical_import_receipts`).Scan(&receipts); err != nil || receipts != 4 {
		t.Fatalf("receipts=%d err=%v", receipts, err)
	}
	// Imported ids advance their sequences: the next user cannot collide.
	var next int64
	if err = pool.QueryRow(ctx, `INSERT INTO users (username, lower_username) VALUES ('native', 'native') RETURNING id`).Scan(&next); err != nil || next <= 42 {
		t.Fatalf("next user id=%d err=%v", next, err)
	}

	changed := archive()
	changed[0].Fields = []byte(`{"id":42,"username":"changed","lower_username":"changed"}`)
	if _, err = i.Apply(ctx, changed); !errors.Is(err, ErrConflict) {
		t.Fatalf("changed replay: %v", err)
	}
	if _, err = i.Apply(ctx, []Row{{Kind: "users", SourceID: "other", Fields: []byte(`{"id":42,"username":"other","lower_username":"other"}`)}}); !errors.Is(err, ErrConflict) {
		t.Fatalf("different contents at an existing key: %v", err)
	}
	if _, err = i.Apply(ctx, []Row{{Kind: "users", SourceID: "alias", Fields: rows[0].Fields}}); !errors.Is(err, ErrConflict) {
		t.Fatalf("a second source claiming one row: %v", err)
	}
	if _, err = i.Apply(ctx, []Row{{Kind: "users", SourceID: "string-key", Fields: []byte(`{"id":"42","username":"legacy42","lower_username":"legacy42","email":"legacy@example.test","lower_email":"legacy@example.test","created_at":"2026-08-01T10:00:00Z"}`)}}); !errors.Is(err, ErrConflict) {
		t.Fatalf("the same key spelled as a string: %v", err)
	}
	if _, err = i.Verify(ctx, rows[1:]); !errors.Is(err, ErrConflict) {
		t.Fatalf("verify of a partial archive: %v", err)
	}
	if _, err = pool.Exec(ctx, `UPDATE owner_model_credentials SET value_encrypted = 'tampered' WHERE user_id = 42`); err != nil {
		t.Fatal(err)
	}
	if _, err = i.Verify(ctx, rows); !errors.Is(err, ErrConflict) {
		t.Fatalf("verify after tamper: %v", err)
	}
	for name, bad := range map[string][]Row{
		"unknown table":   {{Kind: "billing_accounts", SourceID: "x", Fields: []byte(`{"id":1}`)}},
		"duplicate":       {rows[0], rows[0]},
		"empty fields":    {{Kind: "users", SourceID: "x", Fields: []byte(`{}`)}},
		"blank source id": {{Kind: "users", SourceID: "", Fields: rows[0].Fields}},
	} {
		if _, err = i.DryRun(bad); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	if _, err = i.Apply(ctx, []Row{{Kind: "users", SourceID: "bad-column", Fields: []byte(`{"id":7,"nope":1}`)}}); err == nil {
		t.Error("unknown column accepted")
	}
}
