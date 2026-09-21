//go:build load

package routes

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

const defaultWorkspaceCreateLoadTestDatabaseURL = "postgres://smithers:smithers@127.0.0.1:5432/smithers_test_routes?sslmode=disable"

func TestWorkspaceCreateLoad_ConcurrentCreatesHonorUserCap(t *testing.T) {
	pool := setupWorkspaceCreateLoadTestPool(t)
	queries := db.New(pool)
	ctx := context.Background()

	user, owner, repoName := seedWorkspaceCreateLoadTestUser(t, pool, queries, 99)
	handler := &WorkspaceHandler{
		Service: services.NewWorkspaceService(
			queries,
			services.WithWorkspaceGitBaseURL("http://smithers.test"),
			services.WithWorkspaceSandboxClient(&workspaceCreateLoadSandbox{}),
		),
	}
	server := httptest.NewServer(workspaceCreateLoadRouter(queries, user, handler))
	t.Cleanup(server.Close)

	const requestCount = 50
	results := make([]workspaceCreateLoadResult, requestCount)
	start := make(chan struct{})
	var wg sync.WaitGroup
	client := &http.Client{Timeout: 15 * time.Second}

	for i := 0; i < requestCount; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start

			body := fmt.Sprintf(`{"name":"race-%02d"}`, i)
			req, err := http.NewRequestWithContext(
				context.Background(),
				http.MethodPost,
				fmt.Sprintf("%s/api/repos/%s/%s/workspaces", server.URL, owner, repoName),
				bytes.NewBufferString(body),
			)
			if err != nil {
				results[i].err = err
				return
			}
			req.Header.Set("Content-Type", "application/json")

			resp, err := client.Do(req)
			if err != nil {
				results[i].err = err
				return
			}
			defer resp.Body.Close()
			responseBody, _ := io.ReadAll(resp.Body)
			results[i] = workspaceCreateLoadResult{
				status:     resp.StatusCode,
				retryAfter: resp.Header.Get("Retry-After"),
				body:       strings.TrimSpace(string(responseBody)),
			}
		}(i)
	}

	close(start)
	wg.Wait()

	statusCounts := map[int]int{}
	var created, throttled, serverErrors, missingRetryAfter int
	for i, result := range results {
		require.NoErrorf(t, result.err, "request %d failed before receiving a response", i)
		statusCounts[result.status]++
		switch {
		case result.status == http.StatusCreated:
			created++
		case result.status == http.StatusTooManyRequests:
			throttled++
			if result.retryAfter == "" {
				missingRetryAfter++
			}
		case result.status >= 500:
			serverErrors++
		}
	}

	assert.Equal(t, 1, created, "status counts: %#v; responses: %#v", statusCounts, results)
	assert.Equal(t, 49, throttled, "status counts: %#v; responses: %#v", statusCounts, results)
	assert.Zero(t, missingRetryAfter, "all 429 responses must include Retry-After")
	assert.Zero(t, serverErrors, "status counts: %#v; responses: %#v", statusCounts, results)

	finalCount, err := queries.CountActiveWorkspacesByUser(ctx, user.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(100), finalCount)
}

type workspaceCreateLoadResult struct {
	status     int
	retryAfter string
	body       string
	err        error
}

func workspaceCreateLoadRouter(queries *db.Queries, user db.User, handler *WorkspaceHandler) http.Handler {
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{User: &user})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
	r.With(middleware.LoadRepoContext(queries), middleware.RequireRepoPermission(middleware.PermissionWrite)).
		Post("/api/repos/{owner}/{repo}/workspaces", handler.CreateWorkspace)
	return r
}

func seedWorkspaceCreateLoadTestUser(t *testing.T, pool *pgxpool.Pool, queries *db.Queries, existingWorkspaces int) (db.User, string, string) {
	t.Helper()

	ctx := context.Background()
	suffix := time.Now().UnixNano()
	owner := fmt.Sprintf("workspace-load-%d", suffix)
	repoName := "cap-race"
	email := owner + "@example.test"

	user, err := queries.CreateUser(ctx, db.CreateUserParams{
		Username:      owner,
		LowerUsername: strings.ToLower(owner),
		Email:         pgtype.Text{String: email, Valid: true},
		LowerEmail:    pgtype.Text{String: strings.ToLower(email), Valid: true},
		DisplayName:   owner,
	})
	require.NoError(t, err)

	var repoID int64
	err = pool.QueryRow(
		ctx,
		`INSERT INTO repositories (user_id, name, lower_name, description, storage_set_id, is_public, default_bookmark)
		 VALUES ($1, $2, $3, '', 's1', TRUE, 'main')
		 RETURNING id`,
		user.ID,
		repoName,
		strings.ToLower(repoName),
	).Scan(&repoID)
	require.NoError(t, err)

	for i := 0; i < existingWorkspaces; i++ {
		_, err := pool.Exec(
			ctx,
			`INSERT INTO workspaces (repository_id, user_id, name, is_fork, vm_id, status)
			 VALUES ($1, $2, $3, TRUE, $4, 'running')`,
			repoID,
			user.ID,
			fmt.Sprintf("seed-%02d", i),
			fmt.Sprintf("seed-vm-%02d", i),
		)
		require.NoError(t, err)
	}

	count, err := queries.CountActiveWorkspacesByUser(ctx, user.ID)
	require.NoError(t, err)
	require.Equal(t, int64(existingWorkspaces), count)
	return user, owner, repoName
}

func setupWorkspaceCreateLoadTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()

	if testing.Short() {
		t.Skip("skipping DB load test in short mode")
	}

	pool, err := resetWorkspaceCreateLoadTestDatabase(workspaceCreateLoadTestDatabaseURL())
	if err != nil {
		t.Skipf("skipping DB load test: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func workspaceCreateLoadTestDatabaseURL() string {
	if v := strings.TrimSpace(os.Getenv("SMITHERS_ROUTES_TEST_DATABASE_URL")); v != "" {
		return v
	}
	if v := strings.TrimSpace(os.Getenv("SMITHERS_TEST_DATABASE_URL")); v != "" {
		return v
	}
	return defaultWorkspaceCreateLoadTestDatabaseURL
}

func resetWorkspaceCreateLoadTestDatabase(databaseURL string) (*pgxpool.Pool, error) {
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("bad database URL: %w", err)
	}

	dbName := strings.TrimPrefix(parsed.Path, "/")
	adminURL := *parsed
	adminURL.Path = "/postgres"

	adminConn, err := pgx.Connect(context.Background(), adminURL.String())
	if err != nil {
		return nil, fmt.Errorf("cannot connect to admin database: %w", err)
	}
	defer adminConn.Close(context.Background())

	var exists bool
	if err := adminConn.QueryRow(context.Background(), `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)`, dbName).Scan(&exists); err != nil {
		return nil, fmt.Errorf("check database existence: %w", err)
	}
	if !exists {
		if _, err := adminConn.Exec(context.Background(), `CREATE DATABASE "`+strings.ReplaceAll(dbName, `"`, `""`)+`"`); err != nil {
			return nil, fmt.Errorf("create database: %w", err)
		}
	}

	schemaBytes, err := os.ReadFile(findWorkspaceCreateLoadSchemaPath())
	if err != nil {
		return nil, fmt.Errorf("read schema: %w", err)
	}

	schemaConn, err := pgx.Connect(context.Background(), databaseURL)
	if err != nil {
		return nil, fmt.Errorf("connect to test database: %w", err)
	}
	defer schemaConn.Close(context.Background())

	if _, err := schemaConn.Exec(context.Background(), `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`); err != nil {
		return nil, fmt.Errorf("terminate existing connections: %w", err)
	}

	combined := `DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;` + "\n" + string(schemaBytes)
	if _, err := schemaConn.Exec(context.Background(), combined); err != nil {
		return nil, fmt.Errorf("reset schema: %w", err)
	}

	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("bad pool config: %w", err)
	}
	cfg.MaxConns = 64
	cfg.MinConns = 4
	return pgxpool.NewWithConfig(context.Background(), cfg)
}

func findWorkspaceCreateLoadSchemaPath() string {
	candidates := []string{
		filepath.Join("..", "..", "db", "schema.sql"),
		filepath.Join("db", "schema.sql"),
	}
	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return candidates[0]
}

type workspaceCreateLoadSandbox struct {
	nextVMID int64
}

func (s *workspaceCreateLoadSandbox) CreateSandbox(context.Context, sandbox.CreateRequest) (sandbox.CreateResult, error) {
	id := atomic.AddInt64(&s.nextVMID, 1)
	return sandbox.CreateResult{ID: fmt.Sprintf("load-vm-%d", id)}, nil
}

func (s *workspaceCreateLoadSandbox) ForkSandbox(context.Context, string, sandbox.ForkRequest) (sandbox.CreateResult, error) {
	id := atomic.AddInt64(&s.nextVMID, 1)
	return sandbox.CreateResult{ID: fmt.Sprintf("load-fork-vm-%d", id)}, nil
}

func (s *workspaceCreateLoadSandbox) CreateService(context.Context, string, sandbox.ServiceSpec) (sandbox.CreateServiceResult, error) {
	return sandbox.CreateServiceResult{Success: true}, nil
}

func (s *workspaceCreateLoadSandbox) InspectSandbox(_ context.Context, vmID string) (sandbox.Sandbox, error) {
	return sandbox.Sandbox{ID: vmID, State: sandbox.StateRunning}, nil
}

func (s *workspaceCreateLoadSandbox) DeleteSandbox(context.Context, string) error {
	return nil
}

func (s *workspaceCreateLoadSandbox) StartSandbox(_ context.Context, vmID string, _ sandbox.StartRequest) (sandbox.StartResult, error) {
	return sandbox.StartResult{ID: vmID}, nil
}

func (s *workspaceCreateLoadSandbox) SuspendSandbox(_ context.Context, vmID string) (sandbox.SuspendResult, error) {
	return sandbox.SuspendResult{ID: vmID}, nil
}

func (s *workspaceCreateLoadSandbox) SnapshotSandbox(_ context.Context, vmID string, _ sandbox.SnapshotRequest) (sandbox.SnapshotResult, error) {
	return sandbox.SnapshotResult{SnapshotID: "load-snapshot", SourceSandboxID: vmID}, nil
}

func (s *workspaceCreateLoadSandbox) DeleteSnapshot(context.Context, string) error {
	return nil
}

func (s *workspaceCreateLoadSandbox) CreateIdentity(context.Context) (sandbox.Identity, error) {
	return sandbox.Identity{ID: "load-identity"}, nil
}

func (s *workspaceCreateLoadSandbox) GrantAccess(context.Context, string, string, sandbox.GrantAccessRequest) (sandbox.AccessGrant, error) {
	return sandbox.AccessGrant{ID: "load-permission"}, nil
}

func (s *workspaceCreateLoadSandbox) CreateIdentityToken(context.Context, string) (sandbox.CreatedToken, error) {
	return sandbox.CreatedToken{ID: "load-token", Token: "load-token"}, nil
}
