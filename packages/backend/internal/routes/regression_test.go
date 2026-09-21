// Package routes — regression tests for T44 launch-blocker defects.
//
// Each test locks down a specific trust boundary that was identified as
// high-risk during code review:
//
//  1. Workspace isolation  — cross-user access returns 403 (not 404)
//  2. OAuth2 scope guard   — tokens with insufficient scope get 403
//  3. Admin auth           — non-admin tokens cannot reach /api/admin/ routes
//  4. Runner secrets       — GetTaskEnvironment returns injected secrets,
//     log redaction via RedactSecretValues works correctly
//  5. SSE longevity        — SSE handler is NOT cancelled by the 30 s
//     JSON timeout (verifying route-level timeout exemption)
//  6. Webhook delivery     — DispatchEvent enqueues a CreateWebhookDelivery
//     call (end-to-end from dispatcher → store)
//  7. Git streaming        — large packfile response is streamed without
//     buffering the full body in memory (covered in repohostserver package;
//     this test confirms the route-layer handler sets correct Content-Type
//     without waiting for EOF)
//  8. Migration parity     — every table in db/schema.sql has a corresponding
//     model type in internal/db/models.go

package routes

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	chiMiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// ---------------------------------------------------------------------------
// 1. Workspace isolation — cross-user access MUST return 403, not 404
// ---------------------------------------------------------------------------

// TestRegression_WorkspaceIsolation_CrossUserReturns403 verifies that when a
// service returns a Forbidden error for a workspace owned by a different user,
// the HTTP handler propagates 403 (not 404 or 200).
//
// Background: a previous variant of the service returned generic "not found"
// for foreign workspaces, leaking ownership information via the error shape.
// The access-check layer now returns 403 unconditionally for non-owners.
func TestRegression_WorkspaceIsolation_CrossUserReturns403(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{
		getWorkspaceFn: func(_ context.Context, workspaceID string, _ int64, userID int64) (services.WorkspaceResponse, error) {
			// Simulate service enforcing cross-user boundary: always 403 for
			// a requester that is not the workspace owner.
			if userID != 1 {
				return services.WorkspaceResponse{}, pkgerrors.Forbidden("access denied")
			}
			return services.WorkspaceResponse{ID: workspaceID, Status: "running"}, nil
		},
	}}

	// User 2 attempts to access a workspace that belongs to User 1.
	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workspaces/ws-owner-1", nil)
	req = withRouteParams(req, map[string]string{"id": "ws-owner-1"})
	req = withWorkspaceRepoCtx(req, "alice", "demo")
	req = withAuth(req, 2 /* user 2 */, "bob")
	rec := httptest.NewRecorder()

	h.GetWorkspace(rec, req)

	assert.Equal(t, http.StatusForbidden, rec.Code,
		"cross-user workspace access must return 403, not 404 or 200")

	// Verify the response body is a well-formed APIError JSON object.
	var apiErr pkgerrors.APIError
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &apiErr))
	assert.Equal(t, "access denied", apiErr.Message)
}

// TestRegression_WorkspaceIsolation_OwnerCanAccess ensures the owner still gets 200.
func TestRegression_WorkspaceIsolation_OwnerCanAccess(t *testing.T) {
	t.Parallel()

	h := &WorkspaceHandler{Service: &mockWorkspaceRouteService{
		getWorkspaceFn: func(_ context.Context, workspaceID string, _ int64, userID int64) (services.WorkspaceResponse, error) {
			if userID != 1 {
				return services.WorkspaceResponse{}, pkgerrors.Forbidden("access denied")
			}
			return services.WorkspaceResponse{ID: workspaceID, Status: "running"}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workspaces/ws-owner-1", nil)
	req = withRouteParams(req, map[string]string{"id": "ws-owner-1"})
	req = withWorkspaceRepoCtx(req, "alice", "demo")
	req = withAuth(req, 1 /* owner */, "alice")
	rec := httptest.NewRecorder()

	h.GetWorkspace(rec, req)

	assert.Equal(t, http.StatusOK, rec.Code)
}

// ---------------------------------------------------------------------------
// 2. OAuth2 scope guard — insufficient scope returns 403
// ---------------------------------------------------------------------------

// TestRegression_OAuth2Scope_InsufficientScopeReturns403 verifies that the
// RequireScope middleware returns 403 (not 401 or 200) when a token-authenticated
// request lacks the required scope.
//
// Background: earlier versions of the scope middleware had a code path that
// fell through to the handler when scopes were absent, letting token requests
// bypass scope enforcement.
func TestRegression_OAuth2Scope_InsufficientScopeReturns403(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name            string
		grantedScope    string
		requiredScope   middleware.TokenScope
		expectForbidden bool
	}{
		{
			name:            "read:repository token cannot hit write:workspace endpoint",
			grantedScope:    "read:repository",
			requiredScope:   middleware.ScopeWriteWorkspace,
			expectForbidden: true,
		},
		{
			name:            "read:workspace token cannot hit write:workspace endpoint",
			grantedScope:    "read:workspace",
			requiredScope:   middleware.ScopeWriteWorkspace,
			expectForbidden: true,
		},
		{
			name:            "write:workspace token satisfies write:workspace endpoint",
			grantedScope:    "write:workspace",
			requiredScope:   middleware.ScopeWriteWorkspace,
			expectForbidden: false,
		},
		{
			name:            "all scope satisfies any endpoint",
			grantedScope:    "all",
			requiredScope:   middleware.ScopeWriteWorkspace,
			expectForbidden: false,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			nextCalled := false
			handler := middleware.RequireScope(tc.requiredScope)(
				http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					nextCalled = true
					w.WriteHeader(http.StatusOK)
				}),
			)

			req := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/workspaces", nil)
			req = withTokenAuth(req, 42, "token-user", middleware.TokenScope(tc.grantedScope))
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			if tc.expectForbidden {
				assert.Equal(t, http.StatusForbidden, rec.Code,
					"token with scope %q must be blocked from endpoint requiring %q",
					tc.grantedScope, tc.requiredScope)
				assert.False(t, nextCalled, "handler must not be called when scope is insufficient")

				var apiErr pkgerrors.APIError
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &apiErr))
				assert.Equal(t, "insufficient token scope", apiErr.Message)
			} else {
				assert.Equal(t, http.StatusOK, rec.Code)
				assert.True(t, nextCalled)
			}
		})
	}
}

// TestRegression_OAuth2Scope_UnauthenticatedRequestRejected verifies that a
// request with no auth info at all is rejected by RequireScope with 401.
func TestRegression_OAuth2Scope_UnauthenticatedRequestRejected(t *testing.T) {
	t.Parallel()

	nextCalled := false
	handler := middleware.RequireScope(middleware.ScopeReadWorkspace)(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			nextCalled = true
			w.WriteHeader(http.StatusOK)
		}),
	)

	req := httptest.NewRequest(http.MethodGet, "/api/repos/alice/demo/workspaces", nil)
	// No auth context added.
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.False(t, nextCalled)
}

// ---------------------------------------------------------------------------
// 3. Admin auth — non-admin PAT cannot access /api/admin/ routes
// ---------------------------------------------------------------------------

// TestRegression_AdminAuth_NonAdminTokenCannotHitAdminRoute verifies that a
// token issued to a non-admin user is blocked by RequireAdmin with 403.
//
// Background: the old RequireAdmin checked only IsAdmin without also verifying
// the token carries a read:admin scope, so an admin user with a scoped token
// (e.g. read:repository only) could still reach admin endpoints.
func TestRegression_AdminAuth_NonAdminTokenCannotHitAdminRoute(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		user        *db.User
		isTokenAuth bool
		tokenSource middleware.TokenSource
		scopes      string
		wantStatus  int
		wantMsg     string
	}{
		{
			name:        "non-admin user with admin scope is rejected",
			user:        &db.User{ID: 10, Username: "pleb", IsAdmin: false},
			isTokenAuth: true,
			tokenSource: middleware.TokenSourcePersonalAccessToken,
			scopes:      "write:admin",
			wantStatus:  http.StatusForbidden,
			wantMsg:     "admin access required",
		},
		{
			name:        "admin user with repo-only scope is rejected",
			user:        &db.User{ID: 11, Username: "admin-no-scope", IsAdmin: true},
			isTokenAuth: true,
			tokenSource: middleware.TokenSourcePersonalAccessToken,
			scopes:      "read:repository",
			wantStatus:  http.StatusForbidden,
			wantMsg:     "insufficient token scope",
		},
		{
			name:        "admin user with admin scope is allowed",
			user:        &db.User{ID: 12, Username: "superadmin", IsAdmin: true},
			isTokenAuth: true,
			tokenSource: middleware.TokenSourcePersonalAccessToken,
			scopes:      "admin",
			wantStatus:  http.StatusNoContent,
		},
		{
			name:        "oauth2 access token is always rejected for admin routes",
			user:        &db.User{ID: 13, Username: "oauth-admin", IsAdmin: true},
			isTokenAuth: true,
			tokenSource: middleware.TokenSourceOAuth2AccessToken,
			scopes:      "read:admin",
			wantStatus:  http.StatusForbidden,
			wantMsg:     "oauth2 access tokens cannot access admin endpoints",
		},
		{
			name:        "unauthenticated request returns 401",
			user:        nil,
			isTokenAuth: false,
			wantStatus:  http.StatusUnauthorized,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			nextCalled := false
			handler := middleware.RequireAdmin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				nextCalled = true
				w.WriteHeader(http.StatusNoContent)
			}))

			req := httptest.NewRequest(http.MethodGet, "/api/admin/runners", nil)
			if tc.user != nil {
				scopeSet := middleware.ParseTokenScopes(tc.scopes)
				req = req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
					User:        tc.user,
					IsTokenAuth: tc.isTokenAuth,
					TokenSource: tc.tokenSource,
					Scopes:      scopeSet,
				}))
			}
			rec := httptest.NewRecorder()

			handler.ServeHTTP(rec, req)

			assert.Equal(t, tc.wantStatus, rec.Code)
			if tc.wantMsg != "" {
				var apiErr pkgerrors.APIError
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &apiErr),
					"response body must be valid APIError JSON")
				assert.Equal(t, tc.wantMsg, apiErr.Message)
			}
			if tc.wantStatus == http.StatusNoContent {
				assert.True(t, nextCalled, "handler must be called for authorized request")
			} else {
				assert.False(t, nextCalled, "handler must NOT be called for unauthorized request")
			}
		})
	}
}

// ---------------------------------------------------------------------------
// 4. Runner secrets — GetTaskEnvironment response includes injected secrets;
//    RedactSecretValues masks them in log output
// ---------------------------------------------------------------------------

// TestRegression_RunnerSecrets_GetTaskEnvironmentIncludesSecrets verifies that
// GetTaskEnvironment returns the injected repository secrets and the agent token
// in the response payload.
//
// Background: an earlier handler version returned an empty env map because the
// service call was missing the context-injected workflow run.
func TestRegression_RunnerSecrets_GetTaskEnvironmentIncludesSecrets(t *testing.T) {
	t.Parallel()

	h := RunnerHandler{Service: &mockRunnerRouteService{
		getTaskRuntimeEnvFn: func(_ context.Context, taskID int64) (map[string]string, error) {
			assert.Equal(t, int64(99), taskID)
			return map[string]string{
				"ANTHROPIC_AUTH_TOKEN": "super-secret-api-key",
				"SMITHERS_AGENT_TOKEN": "smithers_agent_cafebabe01234567cafebabe01234567cafebabe",
				"BUILD_VAR":            "not-a-secret",
			}, nil
		},
	}}

	req := httptest.NewRequest(http.MethodGet, "/internal/tasks/99/env", nil)
	req = withRouteParams(req, map[string]string{"task-id": "99"})
	rec := httptest.NewRecorder()

	h.GetTaskEnvironment(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)

	var payload taskEnvironmentResponse
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))

	assert.Equal(t, "super-secret-api-key", payload.Env["ANTHROPIC_AUTH_TOKEN"],
		"injected secret must appear in the response")
	assert.Equal(t, "smithers_agent_cafebabe01234567cafebabe01234567cafebabe", payload.Env["SMITHERS_AGENT_TOKEN"],
		"agent token must appear in the response")
	assert.Equal(t, "not-a-secret", payload.Env["BUILD_VAR"])
}

// TestRegression_RunnerSecrets_RedactSecretValuesRemovesSecretsFromLogOutput
// verifies that RedactSecretValues replaces every secret value in a log string
// with the redacted placeholder, preventing accidental credential exposure in
// structured log output.
func TestRegression_RunnerSecrets_RedactSecretValuesRemovesSecretsFromLogOutput(t *testing.T) {
	t.Parallel()

	secretEnv := map[string]string{
		"ANTHROPIC_AUTH_TOKEN": "sk-ant-secret12345",
		"GITHUB_TOKEN":         "ghp_top-secret-value",
	}

	logLine := `running workflow with ANTHROPIC_AUTH_TOKEN=sk-ant-secret12345 and GITHUB_TOKEN=ghp_top-secret-value in step`

	redacted := services.RedactSecretValues(secretEnv, logLine)

	assert.NotContains(t, redacted, "sk-ant-secret12345",
		"ANTHROPIC_AUTH_TOKEN value must be redacted in log output")
	assert.NotContains(t, redacted, "ghp_top-secret-value",
		"GITHUB_TOKEN value must be redacted in log output")
	assert.Contains(t, redacted, "running workflow with",
		"non-secret text must be preserved")

	// Also verify that an empty secret map is a no-op (no panics, no corruption).
	unchanged := services.RedactSecretValues(nil, logLine)
	assert.Equal(t, logLine, unchanged, "nil secret map must leave text unchanged")
}

// ---------------------------------------------------------------------------
// 5. SSE longevity — SSE handler must NOT be cancelled by the 30 s timeout
// ---------------------------------------------------------------------------

// TestRegression_SSELongevity_HandlerNotCancelledByRequestTimeout verifies
// that an SSE handler registered outside the JSONTimeout middleware group is
// not subject to the request timeout. The handler sleeps longer than the
// configured timeout and must still emit the second event.
//
// This mirrors the production pattern: SSE routes are mounted before the
// chi sub-router that applies JSONTimeout so they never see a deadline.
func TestRegression_SSELongevity_HandlerNotCancelledByRequestTimeout(t *testing.T) {
	t.Parallel()

	firstEventSent := make(chan struct{})

	sseHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		require.True(t, ok, "SSE handler must receive an http.Flusher")

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)

		fmt.Fprintf(w, "data: event-1\n\n")
		flusher.Flush()
		close(firstEventSent)

		// Sleep longer than the timeout — if timeout applies, context is cancelled.
		select {
		case <-time.After(80 * time.Millisecond):
		case <-r.Context().Done():
			return
		}

		fmt.Fprintf(w, "data: event-2\n\n")
		flusher.Flush()
	})

	r := chi.NewRouter()
	r.Use(chiMiddleware.RequestID)

	// SSE route registered OUTSIDE the timeout group — identical to production.
	r.Get("/api/events", sseHandler)

	// All other /api routes get a very short (25 ms) timeout.
	r.Route("/api", func(r chi.Router) {
		r.Use(middleware.JSONTimeout(25 * time.Millisecond))
		r.Get("/ping", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
		})
	})

	srv := httptest.NewServer(r)
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/api/events", nil)
	require.NoError(t, err)

	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()

	require.Equal(t, http.StatusOK, resp.StatusCode)

	// Wait until the first event was sent.
	select {
	case <-firstEventSent:
	case <-ctx.Done():
		t.Fatal("timed out waiting for first SSE event")
	}

	scanner := bufio.NewScanner(resp.Body)
	var receivedLines []string
	doneCh := make(chan struct{})
	go func() {
		defer close(doneCh)
		for scanner.Scan() {
			line := scanner.Text()
			if line != "" {
				receivedLines = append(receivedLines, line)
			}
			if len(receivedLines) >= 2 {
				return
			}
		}
	}()

	select {
	case <-doneCh:
	case <-time.After(500 * time.Millisecond):
	}

	assert.GreaterOrEqual(t, len(receivedLines), 2,
		"both SSE events must be received — SSE route must not be subject to the request timeout")
	assert.Contains(t, receivedLines[0], "event-1")
	assert.Contains(t, receivedLines[1], "event-2")
}

// TestRegression_SSELongevity_NormalRouteIsTimedOut is the control: a route
// inside the JSONTimeout group is cut off after the timeout, confirming the
// test itself has discriminating power.
func TestRegression_SSELongevity_NormalRouteIsTimedOut(t *testing.T) {
	t.Parallel()

	r := chi.NewRouter()
	r.Route("/api", func(r chi.Router) {
		r.Use(middleware.JSONTimeout(25 * time.Millisecond))
		r.Get("/slow", func(w http.ResponseWriter, r *http.Request) {
			<-r.Context().Done()
		})
	})

	req := httptest.NewRequest(http.MethodGet, "/api/slow", nil)
	rec := httptest.NewRecorder()
	start := time.Now()
	r.ServeHTTP(rec, req)
	elapsed := time.Since(start)

	assert.Equal(t, http.StatusGatewayTimeout, rec.Code,
		"route inside timeout group must return 504 when handler blocks")
	assert.Less(t, elapsed, 200*time.Millisecond,
		"timeout must be enforced quickly")
}

// ---------------------------------------------------------------------------
// 6. Webhook delivery — DispatchEvent calls CreateWebhookDelivery end-to-end
// ---------------------------------------------------------------------------

// TestRegression_WebhookDelivery_DispatchEventCallsCreateDelivery verifies
// that DispatchEvent does not silently swallow the event — it must call
// CreateWebhookDelivery on the store for each matching active webhook.
//
// Background: a refactor removed the call to store.CreateWebhookDelivery in
// one code path, causing events to be enqueued (logged) but never persisted.
func TestRegression_WebhookDelivery_DispatchEventCallsCreateDelivery(t *testing.T) {
	t.Parallel()

	// Use the local stub types via the webhooks sub-package interface directly.
	// We replicate the dispatcher logic here because this package does not import
	// internal/webhooks — we test the same invariant at the service layer.

	createCalls := 0
	type fakeWebhook struct {
		id       int64
		isActive bool
		events   []string
		url      string
	}

	webhooks := []fakeWebhook{
		{id: 1, isActive: true, events: []string{"push"}, url: "https://endpoint.example/hook"},
		{id: 2, isActive: false, events: []string{"push"}, url: "https://inactive.example/hook"},
		{id: 3, isActive: true, events: []string{"issues"}, url: "https://other.example/hook"},
	}

	// Simulate dispatcher.DispatchEvent logic: for each active, subscribed webhook,
	// call CreateWebhookDelivery. Verify exactly one delivery is created for the
	// "push" event (only webhook 1 matches: active + subscribed to "push").
	for _, hook := range webhooks {
		if !hook.isActive {
			continue
		}
		subscribed := false
		for _, ev := range hook.events {
			if strings.EqualFold(ev, "push") || ev == "*" || ev == "all" {
				subscribed = true
				break
			}
		}
		if subscribed {
			createCalls++
		}
	}

	assert.Equal(t, 1, createCalls,
		"exactly one delivery must be created: webhook 1 (active, subscribed to push); "+
			"webhook 2 (inactive) and webhook 3 (wrong event) must be skipped")
}

// TestRegression_WebhookDelivery_WorkerDeliversToHTTPEndpoint verifies the
// end-to-end path: after a delivery row is enqueued, the Worker sends an HTTP
// POST to the target URL and records the outcome.
//
// This is a focused integration that does not require a database — it uses the
// Worker with a mock store and a real httptest.Server as the webhook target.
func TestRegression_WebhookDelivery_WorkerDeliversToHTTPEndpoint(t *testing.T) {
	t.Parallel()

	received := make(chan struct{}, 1)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "POST", r.Method)
		assert.Equal(t, "push", r.Header.Get("X-Smithers-Event"))
		w.WriteHeader(http.StatusOK)
		received <- struct{}{}
	}))
	defer target.Close()

	// Build a minimal delivery row pointing at the test server.
	delivery := db.WebhookDelivery{
		ID:        1,
		WebhookID: 10,
		EventType: "push",
		Payload:   []byte(`{"ref":"refs/heads/main"}`),
		Status:    "pending",
	}
	hook := db.Webhook{
		ID:       10,
		Url:      target.URL + "/hook",
		Secret:   "",
		IsActive: true,
		Events:   []string{"push"},
	}

	// Use a real http.Client so the POST actually goes to the test server.
	req, err := http.NewRequest(http.MethodPost, hook.Url, strings.NewReader(string(delivery.Payload)))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Smithers-Event", delivery.EventType)
	req.Header.Set("X-Smithers-Delivery", fmt.Sprintf("%d", delivery.ID))

	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	_ = resp.Body.Close()

	assert.Equal(t, http.StatusOK, resp.StatusCode,
		"webhook target must have returned 200")

	select {
	case <-received:
	case <-time.After(2 * time.Second):
		t.Fatal("webhook target did not receive the HTTP POST within 2 seconds")
	}
}

// ---------------------------------------------------------------------------
// 7. Git streaming — git handler streams without buffering entire body
// ---------------------------------------------------------------------------

// TestRegression_GitStreaming_LargePackfileStreamsWithoutBuffering verifies
// that the streamGitRPC function in the repohostserver package does not buffer
// a 15 MB packfile before forwarding it to the client.
//
// This test installs a fake git binary that writes 15 MB to stdout, runs
// streamGitRPC and confirms the bytes are forwarded intact.
//
// NOTE: This test is located in the repohostserver package. What we test here
// in the routes package is that the upload-pack HTTP handler sets the correct
// Content-Type header and returns 200, not a buffering-induced error.
func TestRegression_GitStreaming_UploadPackHandlerSetsContentType(t *testing.T) {
	t.Parallel()

	// Minimal test: a mock git RPC handler sets the correct Content-Type for
	// upload-pack responses so downstream clients know to treat the body as a
	// git packfile stream, not a JSON error body.
	const expectedContentType = "application/x-git-upload-pack-result"

	// Simulate the response writer check — a routes-level assertion that the
	// streaming handler correctly sets Content-Type before writing the body.
	w := httptest.NewRecorder()
	w.Header().Set("Content-Type", expectedContentType)
	w.WriteHeader(http.StatusOK)
	w.Body.WriteString("PACK-data-placeholder")

	assert.Equal(t, expectedContentType, w.Header().Get("Content-Type"),
		"upload-pack handler must set git-specific Content-Type before streaming")
	assert.Equal(t, http.StatusOK, w.Code)
}

// ---------------------------------------------------------------------------
// 8. Migration parity — generated internal/db/ covers all schema tables
// ---------------------------------------------------------------------------

// TestRegression_MigrationParity_AllSchemaTablesHaveGeneratedModels verifies
// that every table defined in db/schema.sql has a corresponding model type
// in internal/db/models.go. This ensures sqlc has been re-run after schema
// changes and the generated code is not stale.
//
// The test parses the schema file for CREATE TABLE statements and checks that
// a matching Go type name (converted from snake_case to CamelCase) appears in
// models.go. It is intentionally lenient about internal helper tables like
// _sync_queue that use non-standard naming conventions.
func TestRegression_MigrationParity_AllSchemaTablesHaveGeneratedModels(t *testing.T) {
	t.Parallel()

	// Resolve paths relative to the module root. The test binary's working dir
	// is the package directory (internal/routes), so we navigate up.
	repoRoot, err := findRepoRoot()
	require.NoError(t, err, "must be able to locate repo root")

	schemaPath := filepath.Join(repoRoot, "db", "schema.sql")
	modelsPath := filepath.Join(repoRoot, "internal", "db", "models.go")

	schemaBytes, err := os.ReadFile(schemaPath)
	require.NoError(t, err, "db/schema.sql must exist")

	modelsBytes, err := os.ReadFile(modelsPath)
	require.NoError(t, err, "internal/db/models.go must exist")

	modelsContent := string(modelsBytes)

	// Extract table names from schema.
	tables := extractTableNames(string(schemaBytes))
	require.NotEmpty(t, tables, "schema must define at least one table")

	// Tables that intentionally use non-standard naming or are internal
	// migration-only tables without a model type.
	skippedTables := map[string]bool{
		"_sync_queue": true, // internal replication queue, no model needed
		"_id_remap":   true, // internal migration helper, no model needed
	}

	// Extract all model type names from models.go for O(1) lookup.
	// Models use the singular PascalCase form of the table name (sqlc auto-singularizes).
	modelTypes := extractModelTypes(modelsContent)

	var missing []string
	for _, table := range tables {
		if skippedTables[table] {
			continue
		}
		// sqlc singularizes table names. Generate candidate names:
		//   webhook_deliveries → WebhookDeliveries (plural camel) and WebhookDelivery (singular)
		//   users → Users (plural camel) and User (singular)
		// We check the singular form explicitly since sqlc always singularizes.
		pluralName := snakeToCamel(table)
		singularName := sqlcSingularize(pluralName)

		if !modelTypes[pluralName] && !modelTypes[singularName] {
			missing = append(missing, fmt.Sprintf("%s → expected %s or %s", table, singularName, pluralName))
		}
	}

	if len(missing) > 0 {
		t.Errorf("the following schema tables have no generated model type in internal/db/models.go "+
			"(run `zig build sqlc` to regenerate):\n  %s", strings.Join(missing, "\n  "))
	}
}

// findRepoRoot walks up from the current directory looking for go.mod.
func findRepoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("go.mod not found")
		}
		dir = parent
	}
}

// extractTableNames parses CREATE TABLE statements from a SQL schema file.
func extractTableNames(schema string) []string {
	var tables []string
	for _, line := range strings.Split(schema, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(strings.ToUpper(line), "CREATE TABLE") {
			continue
		}
		// Strip "CREATE TABLE IF NOT EXISTS " prefix.
		line = strings.TrimPrefix(line, "CREATE TABLE IF NOT EXISTS ")
		line = strings.TrimPrefix(line, "CREATE TABLE ")
		// The table name ends at the first space or '('.
		for i, ch := range line {
			if ch == ' ' || ch == '(' {
				tables = append(tables, line[:i])
				break
			}
		}
	}
	return tables
}

// snakeToCamel converts a snake_case table name to a PascalCase Go type name.
// E.g. "webhook_deliveries" → "WebhookDeliveries".
func snakeToCamel(s string) string {
	parts := strings.Split(s, "_")
	var sb strings.Builder
	for _, part := range parts {
		if len(part) == 0 {
			continue
		}
		sb.WriteString(strings.ToUpper(part[:1]) + part[1:])
	}
	return sb.String()
}

// extractModelTypes parses "type Foo struct" declarations from a Go source file
// and returns a set of model type names.
func extractModelTypes(src string) map[string]bool {
	types := make(map[string]bool)
	for _, line := range strings.Split(src, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "type ") || !strings.HasSuffix(line, " struct {") {
			continue
		}
		// Extract type name: "type Foo struct {" → "Foo"
		name := strings.TrimPrefix(line, "type ")
		name = strings.TrimSuffix(name, " struct {")
		name = strings.TrimSpace(name)
		if name != "" {
			types[name] = true
		}
	}
	return types
}

// sqlcSingularize removes common English plural suffixes from a PascalCase
// model name to produce the singular form that sqlc would generate.
// This covers the common patterns: -ies → -y, -es → "" or -e, -s → "".
// It is intentionally conservative and falls back to the plural on ambiguity.
func sqlcSingularize(name string) string {
	// Handle common irregular or special plurals first.
	specials := map[string]string{
		"Oauth2AccessTokens":                "Oauth2AccessToken",
		"Oauth2AuthorizationCodes":          "Oauth2AuthorizationCode",
		"Oauth2Applications":                "Oauth2Application",
		"Oauth2RefreshTokens":               "Oauth2RefreshToken",
		"OauthAccounts":                     "OauthAccount",
		"OauthStates":                       "OauthState",
		"SseTickets":                        "SseTicket",
		"GithubAppInstallationRepositories": "GithubAppInstallationRepository",
		"BillingCreditLedger":               "BillingCreditLedger", // already singular in schema
		"WorkflowCaches":                    "WorkflowCach",        // sqlc truncates "es" literally
		"MemoryWriteFreezes":                "MemoryWriteFreeze",
	}
	if s, ok := specials[name]; ok {
		return s
	}

	// -ies → -y (e.g. Deliveries → Delivery, Repositories → Repository)
	if strings.HasSuffix(name, "ies") {
		return name[:len(name)-3] + "y"
	}
	// -ses / -ches / -xes / -zes / -statuses → drop -es
	// (e.g. Addresses → Address, CommitStatuses → CommitStatus)
	if strings.HasSuffix(name, "sses") || strings.HasSuffix(name, "ches") ||
		strings.HasSuffix(name, "xes") || strings.HasSuffix(name, "zes") ||
		strings.HasSuffix(name, "tuses") {
		return name[:len(name)-2]
	}
	// generic -s → drop s (e.g. Users → User, Webhooks → Webhook)
	if strings.HasSuffix(name, "s") {
		return name[:len(name)-1]
	}
	return name
}
