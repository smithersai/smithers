package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

const testArchive = `{
  "exported_at": "2026-09-25T12:00:00Z",
  "canonical_rows": [
    {"kind": "users", "source_id": "identity:account:7", "fields": {"id": 7, "username": "seven", "lower_username": "seven"}}
  ],
  "billing_accounts": [
    {"source_id": "a7", "owner_type": "user", "owner_id": 7, "balance_nanos": 1500000000,
     "grants": [{"source_key": "stripe:pi_1", "remaining_nanos": 1500000000}], "source": {"account": {"userId": "7"}}},
    {"source_id": "orphan", "balance_nanos": 7000000000,
     "grants": [{"source_key": "promo:1", "remaining_nanos": 7000000000, "expires_at": "2026-10-25T12:00:00Z"}]},
    {"source_id": "empty", "owner_type": "user", "owner_id": 7, "balance_nanos": 0}
  ]
}`

func runCLI(t *testing.T, args ...string) (report, error) {
	t.Helper()
	var out bytes.Buffer
	err := run(context.Background(), args, &out)
	var r report
	if err == nil {
		if e := json.Unmarshal(out.Bytes(), &r); e != nil {
			t.Fatalf("report %q: %v", out.String(), e)
		}
	}
	return r, err
}

func TestLegacyImportCommand(t *testing.T) {
	_, dbURL := postgresfixture.NewProductDatabase(t)
	t.Setenv("DATABASE_URL", dbURL)
	path := filepath.Join(t.TempDir(), "archive.json")
	if err := os.WriteFile(path, []byte(testArchive), 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(testArchive))
	sum := hex.EncodeToString(digest[:])

	dry, err := runCLI(t, "-input", path, "-expect-accounts", "3")
	if err != nil || dry.Mode != "dry-run" || dry.ArchiveSHA256 != sum || dry.Billing.Count != 3 || dry.Billing.Claimed != 2 || dry.Billing.Sealed != 1 || dry.Canonical.Count != 1 {
		t.Fatalf("dry=%+v err=%v", dry, err)
	}
	if _, err = runCLI(t, "-input", path, "-expect-accounts", "23"); err == nil {
		t.Fatal("account count mismatch accepted")
	}
	if _, err = runCLI(t, "-input", path, "-apply", "-sha256", strings.Repeat("0", 64)); err == nil {
		t.Fatal("apply without the sealed digest accepted")
	}
	if _, err = runCLI(t, "-input", path, "-verify", "-sha256", sum); err == nil {
		t.Fatal("verify before apply passed")
	}
	for range 2 {
		applied, err := runCLI(t, "-input", path, "-apply", "-sha256", sum)
		if err != nil || applied.Billing.Owned != 2 || applied.Billing.Sealed != 1 || applied.Billing.Checksum != dry.Billing.Checksum {
			t.Fatalf("apply=%+v err=%v", applied, err)
		}
	}
	verified, err := runCLI(t, "-input", path, "-verify", "-sha256", sum)
	if err != nil || verified.Billing.Owned != 2 || verified.Billing.Sealed != 1 || verified.Canonical.Checksum != dry.Canonical.Checksum {
		t.Fatalf("verify=%+v err=%v", verified, err)
	}
	if err = run(context.Background(), []string{"-attach", "orphan", "-owner", "user:7"}, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	verified, err = runCLI(t, "-input", path, "-verify", "-sha256", sum)
	if err != nil || verified.Billing.Owned != 3 || verified.Billing.Sealed != 0 {
		t.Fatalf("verify after attach=%+v err=%v", verified, err)
	}
	if err = run(context.Background(), []string{"-attach", "orphan", "-owner", "team:7"}, &bytes.Buffer{}); err == nil {
		t.Fatal("invalid owner accepted")
	}
}
