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
)

// Migration 0037 deletes the retired per-folder source-index pages
// (source-<commit>-<digest>) and nothing else, records each deletion in the
// page history, counts them on the wiki row of a repository with a stack, and
// changes nothing when it runs again.
func TestSourceIndexWikiRetirementMigrationDeletesOnlyRetiredPages(t *testing.T) {
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
	if _, err = rand.Read(random[:]); err != nil {
		t.Fatal(err)
	}
	name := "smithers_source_index_migration_" + hex.EncodeToString(random[:])
	if _, err = admin.Exec(ctx, `CREATE DATABASE "`+name+`"`); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := admin.Exec(ctx, `DROP DATABASE "`+name+`" WITH (FORCE)`); err != nil {
			t.Errorf("drop test database: %v", err)
		}
	}()
	dbURL := *adminURL
	dbURL.Path = "/" + name
	pool, err := pgxpool.New(ctx, dbURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	registered, err := registeredMigrations()
	if err != nil {
		t.Fatal(err)
	}
	var retire migration
	for _, m := range registered {
		if m.version == 37 {
			retire = m
			break
		}
		if _, err = pool.Exec(ctx, m.sql, pgx.QueryExecModeSimpleProtocol); err != nil {
			t.Fatalf("migration %d: %v", m.version, err)
		}
	}
	if retire.version != 37 {
		t.Fatal("migration 0037 is not registered")
	}
	head := "0123456789abcdef0123456789abcdef01234567"
	// Repository 1 has a stack and a wiki row, repository 3 a stack without
	// one; repository 2 has neither.
	if _, err = pool.Exec(ctx, `
		INSERT INTO users (id, username, lower_username) VALUES (1, 'alice', 'alice');
		INSERT INTO repositories (id, name, lower_name, user_id) VALUES (1, 'app', 'app', 1), (2, 'lib', 'lib', 1), (3, 'cli', 'cli', 1);
		INSERT INTO mythical_stacks (repository_id, actor_user_id) VALUES (1, 1), (3, 1);
		INSERT INTO mythical_wikis (repository_id) VALUES (1);
		INSERT INTO wiki_pages (repository_id, slug, title, author_id) VALUES
			(1, 'source-`+head+`-00112233aabbccdd', 'index', 1),
			(1, 'source-`+head+head[:24]+`-00112233aabbccde', 'group', 1),
			(2, 'source-`+head+`-00112233aabbccdd', 'index', 1),
			(3, 'source-`+head+`-00112233aabbccdd', 'index', 1),
			(1, 'generated-runtime', 'Runtime', 1),
			(1, 'source-notes', 'A person''s page', 1),
			(1, 'source-`+head+`-short', 'Not the generator''s slug', 1);
	`, pgx.QueryExecModeSimpleProtocol); err != nil {
		t.Fatal(err)
	}
	for run := 0; run < 2; run++ {
		if _, err = pool.Exec(ctx, retire.sql, pgx.QueryExecModeSimpleProtocol); err != nil {
			t.Fatalf("migration 0037 run %d: %v", run+1, err)
		}
		var kept []string
		rows, err := pool.Query(ctx, `SELECT slug FROM wiki_pages ORDER BY slug`)
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var slug string
			if err := rows.Scan(&slug); err != nil {
				t.Fatal(err)
			}
			kept = append(kept, slug)
		}
		rows.Close()
		want := []string{"generated-runtime", "source-" + head + "-short", "source-notes"}
		if len(kept) != len(want) {
			t.Fatalf("run %d kept %v, want %v", run+1, kept, want)
		}
		for i := range want {
			if kept[i] != want[i] {
				t.Fatalf("run %d kept %v, want %v", run+1, kept, want)
			}
		}
		var removed int32
		if err := pool.QueryRow(ctx, `SELECT legacy_pages_removed FROM mythical_wikis WHERE repository_id = 1`).Scan(&removed); err != nil {
			t.Fatal(err)
		}
		if removed != 2 {
			t.Fatalf("run %d: repository 1 counts %d removed pages, want 2", run+1, removed)
		}
		var state string
		if err := pool.QueryRow(ctx, `SELECT state, legacy_pages_removed FROM mythical_wikis WHERE repository_id = 3`).Scan(&state, &removed); err != nil {
			t.Fatal(err)
		}
		if state != "off" || removed != 1 {
			t.Fatalf("run %d: repository 3's new wiki row is %s with %d removed, want off with 1", run+1, state, removed)
		}
		var wikis int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM mythical_wikis`).Scan(&wikis); err != nil {
			t.Fatal(err)
		}
		if wikis != 2 {
			t.Fatalf("a repository without a stack gained a wiki row")
		}
	}
	var deletions int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM wiki_page_revisions WHERE deleted AND slug LIKE 'source-%'`).Scan(&deletions); err != nil {
		t.Fatal(err)
	}
	if deletions != 4 {
		t.Fatalf("history records %d deletions, want 4", deletions)
	}
}
