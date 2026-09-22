package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExternalDatabaseURL(t *testing.T) {
	t.Setenv("SMITHERS_DATABASE_URL", "")
	t.Setenv("DATABASE_URL", "postgres://railway.example/smithers")
	got, err := externalDatabaseURL()
	if err != nil || got != "postgres://railway.example/smithers" {
		t.Fatalf("DATABASE_URL fallback = %q, %v", got, err)
	}
	if os.Getenv("SMITHERS_DATABASE_URL") != got {
		t.Fatal("DATABASE_URL was not mapped to the backend configuration")
	}
	t.Setenv("SMITHERS_DATABASE_URL", "postgres://explicit.example/smithers")
	got, err = externalDatabaseURL()
	if err != nil || got != "postgres://explicit.example/smithers" {
		t.Fatalf("explicit backend URL = %q, %v", got, err)
	}
	t.Setenv("SMITHERS_DATABASE_URL", "")
	t.Setenv("DATABASE_URL", "")
	if _, err := externalDatabaseURL(); err == nil {
		t.Fatal("missing external PostgreSQL URL was accepted")
	}
}

func TestExternalFirstSetupRequiresOperatorToken(t *testing.T) {
	root := t.TempDir()
	t.Setenv("SMITHERS_AUTH_BOOTSTRAP_TOKEN", "")
	if err := requireExternalBootstrapToken(root); err == nil || !strings.Contains(err.Error(), "SMITHERS_AUTH_BOOTSTRAP_TOKEN") {
		t.Fatalf("missing first-setup token = %v", err)
	}
	t.Setenv("SMITHERS_AUTH_BOOTSTRAP_TOKEN", "operator-chosen-setup-token")
	if err := requireExternalBootstrapToken(root); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SMITHERS_AUTH_BOOTSTRAP_TOKEN", "")
	configDir := filepath.Join(root, "config")
	if err := os.Mkdir(configDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configDir, "secrets.json"), []byte("existing installation"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := requireExternalBootstrapToken(root); err != nil {
		t.Fatalf("existing installation should defer to protected secret validation: %v", err)
	}
}

func TestMigrationWithoutDatabaseDoesNotPrepareLocalState(t *testing.T) {
	root := t.TempDir()
	t.Setenv("SMITHERS_DATA_ROOT", root)
	t.Setenv("SMITHERS_DATABASE_URL", "")
	t.Setenv("DATABASE_URL", "")
	if err := run(context.Background(), []string{"migrate", "status"}); err == nil {
		t.Fatal("migration without PostgreSQL was accepted")
	}
	if _, err := os.Stat(filepath.Join(root, "config")); !os.IsNotExist(err) {
		t.Fatalf("migration prepared server secrets: %v", err)
	}
}

func TestServeRequiresPackagedFlowHostsBeforePreparingLocalState(t *testing.T) {
	root := t.TempDir()
	t.Setenv("SMITHERS_DATA_ROOT", root)
	t.Setenv("SMITHERS_NATIVE_POSTGRES_BIN", "/unused/postgres")
	t.Setenv("SMITHERS_FLOW_HOST_MANIFEST", "")
	if err := run(context.Background(), nil); err == nil || !strings.Contains(err.Error(), "SMITHERS_FLOW_HOST_MANIFEST") {
		t.Fatalf("missing Flow bundle = %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "config")); !os.IsNotExist(err) {
		t.Fatalf("missing Flow bundle prepared local secrets: %v", err)
	}
}
