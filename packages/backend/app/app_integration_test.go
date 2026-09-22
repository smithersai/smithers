package app_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/app"
	"github.com/smithersai/smithers/packages/backend/internal/testutil/postgresfixture"
)

func TestStartServesReadyAndBootstrapFromProductPostgres(t *testing.T) {
	raw := os.Getenv("SMITHERS_PRODUCT_TEST_DATABASE_URL")
	if raw == "" {
		if os.Getenv("SMITHERS_REQUIRE_DATABASE_TESTS") == "1" {
			t.Fatal("SMITHERS_PRODUCT_TEST_DATABASE_URL is required")
		}
		t.Skip("set SMITHERS_PRODUCT_TEST_DATABASE_URL for PostgreSQL integration test")
	}
	_, databaseURL := postgresfixture.NewProductDatabase(t, raw)
	repository := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(repository.Close)
	for key, value := range map[string]string{
		"SMITHERS_DATABASE_URL":                  databaseURL,
		"SMITHERS_BLOB_DATA_DIR":                 t.TempDir(),
		"SMITHERS_AUTH_MODE":                     "selfhost",
		"SMITHERS_AUTH_BOOTSTRAP_TOKEN":          "test-bootstrap-token",
		"SMITHERS_AUTH_SESSION_SECRET":           "test-secret",
		"SMITHERS_LFS_SIGNING_SECRET":            "test-lfs-signing-secret",
		"SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY": "test-webhook-key",
		"SMITHERS_REPO_HOST_AUTH_TOKEN":          "repo-token",
		"SMITHERS_REPO_HOST_URL":                 repository.URL,
		"SMITHERS_PUSH_HOOK_CALLBACK_TOKEN":      "push-callback-token",
		"SMITHERS_SERVER_ADDR":                   "127.0.0.1:0",
		"SMITHERS_PUBLIC_URL":                    "http://127.0.0.1:4000",
		"SMITHERS_FEATURE_FLAGS_WORKFLOWS":       "false",
		"SMITHERS_FEATURE_FLAGS_SANDBOXES":       "false",
	} {
		t.Setenv(key, value)
	}
	previousLogger := slog.Default()
	t.Cleanup(func() { slog.SetDefault(previousLogger) })
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	instance, err := app.Start(ctx, app.Config{Role: app.RoleLocal, Stdout: io.Discard, Stderr: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		closeCtx, closeCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer closeCancel()
		if err := instance.Close(closeCtx); err != nil {
			t.Errorf("close app: %v", err)
		}
	})
	for _, path := range []string{"/readyz", "/api/bootstrap"} {
		response := httptest.NewRecorder()
		instance.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("GET %s: status %d, body %s", path, response.Code, response.Body.String())
		}
		var body map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatalf("GET %s JSON: %v", path, err)
		}
		if path == "/readyz" {
			checks, ok := body["checks"].(map[string]any)
			if body["status"] != "ready" || !ok || checks["database"] != "ok" {
				t.Fatalf("readiness response: %v", body)
			}
		}
		if path == "/api/bootstrap" {
			if body["host"] != "local" || body["authFlow"] != "credentials" {
				t.Fatalf("bootstrap response: %v", body)
			}
		}
	}
}
