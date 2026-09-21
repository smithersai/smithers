package services

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// recordedExec captures each Exec issued by the reconcile so the test can assert
// upserts and prunes without a live database.
type recordedExec struct {
	sql  string
	args []any
}

// newReconcileFakeGitHub stands up an httptest server that speaks the subset of
// the GitHub App API the reconcile walks: list installations, mint an
// installation token, then list that installation's repositories.
func newReconcileFakeGitHub(t *testing.T) *httptest.Server {
	t.Helper()
	expiresAt := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/app/installations":
			// Single page (no Link header ⇒ walk terminates).
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`[{"id":4163546,"repository_selection":"selected","account":{"login":"smithersbot","type":"User"}}]`))
		case r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/app/installations/") && strings.HasSuffix(r.URL.Path, "/access_tokens"):
			w.WriteHeader(http.StatusCreated)
			_, _ = fmt.Fprintf(w, `{"token":"ghs_reconcile","expires_at":%q}`, expiresAt.Format(time.RFC3339))
		case r.Method == http.MethodGet && r.URL.Path == "/installation/repositories":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"total_count":1,"repositories":[{"id":42,"name":"MultI","private":true,"owner":{"login":"SmithersBot"}}]}`))
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

// RED: ReconcileGitHubAppInstallations must authenticate as the app, walk the
// installations + their repositories, and UPSERT rows into
// github_app_installation_repositories (owner/repo lowercased, is_private,
// installation_id). There is no such method today — the table is written only by
// webhook events, so pre-webhook installations can never appear. This fails to
// compile / run until the reconcile is implemented.
func TestRepoConnectionService_ReconcileGitHubAppInstallations_UpsertsRepositories(t *testing.T) {
	server := newReconcileFakeGitHub(t)
	defer server.Close()

	t.Setenv(envGitHubAppID, "12345")
	t.Setenv(envGitHubAppPrivateKey, testGitHubAppPrivateKeyPEM(t))
	t.Setenv(envGitHubAppAPIBaseURL, server.URL)

	var mu sync.Mutex
	var execs []recordedExec
	installationPersisted := false
	svc := NewRepoConnectionService(&mockRepoConnectionDB{
		execFn: func(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
			mu.Lock()
			defer mu.Unlock()
			if strings.Contains(sql, "INSERT INTO github_app_installations") {
				installationPersisted = true
			}
			if strings.Contains(sql, "INSERT INTO github_app_installation_repositories") && !installationPersisted {
				return pgconn.NewCommandTag(""), &pgconn.PgError{Code: "23503", ConstraintName: "github_app_installation_repositories_installation_id_fkey"}
			}
			execs = append(execs, recordedExec{sql: sql, args: arguments})
			return pgconn.NewCommandTag("INSERT 0 1"), nil
		},
		queryRowFn: func(ctx context.Context, sql string, args ...any) pgx.Row {
			return mockRepoConnectionRow{scanFn: func(dest ...any) error { return pgx.ErrNoRows }}
		},
	})

	err := svc.ReconcileGitHubAppInstallations(context.Background())
	require.NoError(t, err)

	mu.Lock()
	defer mu.Unlock()
	var upsertedRepo bool
	var upsertedInstallation bool
	for _, e := range execs {
		if strings.Contains(e.sql, "INSERT INTO github_app_installations") {
			assert.Equal(t, []any{int64(4163546), "smithersbot", "User", "selected"}, e.args)
			upsertedInstallation = true
		}
		if strings.Contains(e.sql, "github_app_installation_repositories") && strings.Contains(strings.ToUpper(e.sql), "INSERT") {
			flat := fmt.Sprint(e.args...)
			if strings.Contains(flat, "smithersbot") && strings.Contains(flat, "multi") {
				upsertedRepo = true
			}
		}
	}
	assert.True(t, upsertedInstallation,
		"reconcile must persist the parent installation before its repository mappings")
	assert.True(t, upsertedRepo,
		"reconcile must upsert the installation's repositories (owner/repo lowercased) into github_app_installation_repositories")
}

// RED: when credentials are unconfigured the reconcile must no-op cleanly —
// return nil (no error spam) and never touch the database.
func TestRepoConnectionService_ReconcileGitHubAppInstallations_NoopWhenUnconfigured(t *testing.T) {
	t.Setenv(envGitHubAppID, "")
	t.Setenv(envGitHubAppPrivateKey, "")

	execCalled := false
	svc := NewRepoConnectionService(&mockRepoConnectionDB{
		execFn: func(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
			execCalled = true
			return pgconn.NewCommandTag(""), nil
		},
	})

	err := svc.ReconcileGitHubAppInstallations(context.Background())
	require.NoError(t, err, "reconcile must no-op (nil error) when creds are unconfigured")
	assert.False(t, execCalled, "reconcile must not touch the database when creds are unconfigured")
}
