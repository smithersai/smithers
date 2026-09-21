package services

import (
	"context"
	"flag"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/database"
)

var agentTestDB *pgxpool.Pool

func getTestDatabaseURL() string {
	if url := os.Getenv("SMITHERS_SERVICES_TEST_DATABASE_URL"); url != "" {
		return url
	}
	if url := os.Getenv("SMITHERS_TEST_DATABASE_URL"); url != "" {
		return url
	}
	return "postgres://smithers:smithers@localhost:5432/smithers_test_services?sslmode=disable"
}

func TestMain(m *testing.M) {
	flag.Parse()
	// Unit tests must not create or reset a database just because a local
	// PostgreSQL server happens to be reachable.
	if testing.Short() {
		os.Exit(m.Run())
	}
	databaseURL := getTestDatabaseURL()

	if err := setupServicesIntegrationDatabase(databaseURL); err != nil {
		fmt.Fprintf(os.Stderr, "agent integration database unavailable; integration tests will be skipped: %v\n", err)
	}

	code := m.Run()
	if agentTestDB != nil {
		agentTestDB.Close()
	}
	os.Exit(code)
}

func setupServicesIntegrationDatabase(databaseURL string) error {
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		return fmt.Errorf("bad database URL: %w", err)
	}
	dbName := strings.TrimPrefix(parsed.Path, "/")
	adminURL := *parsed
	adminURL.Path = "/postgres"

	adminConn, err := pgx.Connect(context.Background(), adminURL.String())
	if err != nil {
		return fmt.Errorf("cannot connect to admin database: %w", err)
	}
	defer adminConn.Close(context.Background())

	var exists bool
	_ = adminConn.QueryRow(context.Background(), `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)`, dbName).Scan(&exists)
	if !exists {
		_, _ = adminConn.Exec(context.Background(), `CREATE DATABASE "`+strings.ReplaceAll(dbName, `"`, `""`)+`"`)
	}

	schemaBytes, err := os.ReadFile(findSchemaPath())
	if err != nil {
		return fmt.Errorf("cannot read schema: %w", err)
	}
	schemaConn, err := pgx.Connect(context.Background(), databaseURL)
	if err != nil {
		return fmt.Errorf("cannot connect to test db for schema setup: %w", err)
	}
	defer schemaConn.Close(context.Background())

	_, _ = schemaConn.Exec(context.Background(),
		`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`)
	combined := `DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;` + "\n" + string(schemaBytes)
	if _, err := schemaConn.Exec(context.Background(), combined); err != nil {
		return fmt.Errorf("schema setup failed: %w", err)
	}

	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return fmt.Errorf("bad pool config: %w", err)
	}
	cfg.MaxConns = 20
	cfg.MinConns = 2
	cfg.AfterConnect = func(_ context.Context, conn *pgx.Conn) error {
		database.ConfigureSQLCTypes(conn.TypeMap())
		return nil
	}
	agentTestDB, err = pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		return fmt.Errorf("cannot create pool: %w", err)
	}

	return nil
}

func findSchemaPath() string {
	candidates := []string{
		filepath.Join("..", "..", "db", "schema.sql"),
		filepath.Join("db", "schema.sql"),
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return candidates[0]
}

// getAgentTestPool returns the shared test pool if available, or skips the test.
func getAgentTestPool(t *testing.T) *pgxpool.Pool {
	if testing.Short() {
		t.Skip("skipping DB integration test in short mode")
	}
	if agentTestDB == nil {
		t.Skip("skipping DB integration test: database unavailable")
	}
	return agentTestDB
}
