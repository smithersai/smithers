package middleware

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type mockAgentTokenQuerier struct {
	getWorkflowRunByAgentTokenFn func(ctx context.Context, agentTokenHash pgtype.Text) (db.WorkflowRun, error)
}

func (m *mockAgentTokenQuerier) GetWorkflowRunByAgentToken(ctx context.Context, agentTokenHash pgtype.Text) (db.WorkflowRun, error) {
	if m.getWorkflowRunByAgentTokenFn != nil {
		return m.getWorkflowRunByAgentTokenFn(ctx, agentTokenHash)
	}
	return db.WorkflowRun{}, nil
}

func TestRequireAgentToken_ValidTokenMatchingHash(t *testing.T) {
	expectedRun := db.WorkflowRun{
		ID: 1,
		AgentTokenExpiresAt: pgtype.Timestamptz{
			Time:  time.Now().Add(1 * time.Hour),
			Valid: true,
		},
	}
	mock := &mockAgentTokenQuerier{
		getWorkflowRunByAgentTokenFn: func(ctx context.Context, hash pgtype.Text) (db.WorkflowRun, error) {
			return expectedRun, nil
		},
	}

	handler := RequireAgentToken(mock)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		run := WorkflowRunFromContext(r.Context())
		if run == nil || run.ID != 1 {
			t.Errorf("Expected WorkflowRun in context with ID 1, got %v", run)
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("success"))
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer smithers_agent_abcdef0123456789abcdef0123456789abcdef01")
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", rr.Code)
	}
}

func TestRequireAgentToken_ValidTokenNoExpiry(t *testing.T) {
	expectedRun := db.WorkflowRun{
		ID: 2,
		AgentTokenExpiresAt: pgtype.Timestamptz{
			Valid: false,
		},
	}
	mock := &mockAgentTokenQuerier{
		getWorkflowRunByAgentTokenFn: func(ctx context.Context, hash pgtype.Text) (db.WorkflowRun, error) {
			return expectedRun, nil
		},
	}

	handler := RequireAgentToken(mock)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		run := WorkflowRunFromContext(r.Context())
		if run == nil || run.ID != 2 {
			t.Errorf("Expected WorkflowRun in context with ID 2, got %v", run)
		}
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer smithers_agent_abcdef0123456789abcdef0123456789abcdef01")
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", rr.Code)
	}
}

// The deployment's shared SMITHERS_AGENT_TOKEN guards only the workspace
// status callbacks (RequireSharedBearerToken). It is not a workflow credential:
// on per-run routes it is rejected like any other unknown token.
func TestRequireAgentToken_RejectsSharedDeploymentToken(t *testing.T) {
	for _, sharedToken := range []string{
		"smithers_agent_abcdef0123456789abcdef0123456789abcdef01",
		"e105942e3f8e0a62e105942e3f8e0a62e105942e3f8e0a62",
	} {
		t.Setenv("SMITHERS_AGENT_TOKEN", sharedToken)
		mock := &mockAgentTokenQuerier{
			getWorkflowRunByAgentTokenFn: func(context.Context, pgtype.Text) (db.WorkflowRun, error) {
				return db.WorkflowRun{}, pgx.ErrNoRows
			},
		}
		handler := RequireAgentToken(mock)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t.Fatal("the shared deployment token must not authenticate a workflow route")
		}))

		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Authorization", "Bearer "+sharedToken)
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)

		assert.Equal(t, http.StatusUnauthorized, rr.Code)
	}
}

// A token that does not match the per-run token
// format must 401 at the format gate without ever reaching the database.
func TestRequireAgentToken_RejectsUnformattedTokenWithoutDBLookup(t *testing.T) {
	require.NoError(t, os.Setenv("SMITHERS_AGENT_TOKEN", "shared-credential-value"))
	t.Cleanup(func() { _ = os.Unsetenv("SMITHERS_AGENT_TOKEN") })

	mock := &mockAgentTokenQuerier{
		getWorkflowRunByAgentTokenFn: func(ctx context.Context, hash pgtype.Text) (db.WorkflowRun, error) {
			t.Error("database must not be consulted for unformatted tokens")
			return db.WorkflowRun{}, nil
		},
	}

	handler := RequireAgentToken(mock)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("Handler should not be called")
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer not-the-shared-token-and-not-agent-format")
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	assert.Equal(t, http.StatusUnauthorized, rr.Code)
	if !strings.Contains(rr.Body.String(), "invalid or missing agent token") {
		t.Errorf("Expected body to contain 'invalid or missing agent token', got %s", rr.Body.String())
	}
}

func TestRequireAgentToken_ValidTokenNoDBMatch(t *testing.T) {
	mock := &mockAgentTokenQuerier{
		getWorkflowRunByAgentTokenFn: func(ctx context.Context, hash pgtype.Text) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, pgx.ErrNoRows
		},
	}

	handler := RequireAgentToken(mock)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("Handler should not be called")
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer smithers_agent_abcdef0123456789abcdef0123456789abcdef01")
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("Expected status 401, got %d", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "invalid or expired agent token") {
		t.Errorf("Expected body to contain 'invalid or expired agent token', got %s", rr.Body.String())
	}
}

func TestRequireAgentToken_ValidTokenExpired(t *testing.T) {
	expectedRun := db.WorkflowRun{
		ID: 3,
		AgentTokenExpiresAt: pgtype.Timestamptz{
			Time:  time.Now().Add(-1 * time.Hour),
			Valid: true,
		},
	}
	mock := &mockAgentTokenQuerier{
		getWorkflowRunByAgentTokenFn: func(ctx context.Context, hash pgtype.Text) (db.WorkflowRun, error) {
			return expectedRun, nil
		},
	}

	handler := RequireAgentToken(mock)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("Handler should not be called")
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer smithers_agent_abcdef0123456789abcdef0123456789abcdef01")
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("Expected status 401, got %d", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "agent token expired") {
		t.Errorf("Expected body to contain 'agent token expired', got %s", rr.Body.String())
	}
}

func TestRequireAgentToken_RejectsTerminalWorkflowRunStatus(t *testing.T) {
	terminalStatuses := []string{"success", "failure", "cancelled", "error"}
	nonTerminalStatuses := []string{"running", "queued"}

	for _, status := range terminalStatuses {
		status := status
		t.Run("terminal_"+status, func(t *testing.T) {
			mock := &mockAgentTokenQuerier{
				getWorkflowRunByAgentTokenFn: func(ctx context.Context, hash pgtype.Text) (db.WorkflowRun, error) {
					return db.WorkflowRun{
						ID:     1,
						Status: status,
						AgentTokenExpiresAt: pgtype.Timestamptz{
							Time:  time.Now().Add(1 * time.Hour),
							Valid: true,
						},
					}, nil
				},
			}

			handler := RequireAgentToken(mock)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				t.Error("Handler should not be called for a terminal workflow run")
			}))

			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req.Header.Set("Authorization", "Bearer smithers_agent_abcdef0123456789abcdef0123456789abcdef01")
			rr := httptest.NewRecorder()

			handler.ServeHTTP(rr, req)

			assert.Equal(t, http.StatusUnauthorized, rr.Code)
			assert.Contains(t, rr.Body.String(), "workflow run is terminal")
		})
	}

	for _, status := range nonTerminalStatuses {
		status := status
		t.Run("non_terminal_"+status, func(t *testing.T) {
			mock := &mockAgentTokenQuerier{
				getWorkflowRunByAgentTokenFn: func(ctx context.Context, hash pgtype.Text) (db.WorkflowRun, error) {
					return db.WorkflowRun{
						ID:     1,
						Status: status,
						AgentTokenExpiresAt: pgtype.Timestamptz{
							Time:  time.Now().Add(1 * time.Hour),
							Valid: true,
						},
					}, nil
				},
			}

			called := false
			handler := RequireAgentToken(mock)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				w.WriteHeader(http.StatusOK)
			}))

			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req.Header.Set("Authorization", "Bearer smithers_agent_abcdef0123456789abcdef0123456789abcdef01")
			rr := httptest.NewRecorder()

			handler.ServeHTTP(rr, req)

			assert.Equal(t, http.StatusOK, rr.Code)
			assert.True(t, called)
		})
	}
}

func TestRequireAgentToken_ValidTokenDBError(t *testing.T) {
	mock := &mockAgentTokenQuerier{
		getWorkflowRunByAgentTokenFn: func(ctx context.Context, hash pgtype.Text) (db.WorkflowRun, error) {
			return db.WorkflowRun{}, fmt.Errorf("connection refused")
		},
	}

	handler := RequireAgentToken(mock)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("Handler should not be called")
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer smithers_agent_abcdef0123456789abcdef0123456789abcdef01")
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusInternalServerError {
		t.Errorf("Expected status 500, got %d", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "internal server error") {
		t.Errorf("Expected body to contain 'internal server error', got %s", rr.Body.String())
	}
}

func TestRequireAgentToken_MissingToken(t *testing.T) {
	handler := RequireAgentToken(nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("Handler should not be called without valid token")
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("Expected status 401, got %d", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "invalid or missing agent token") {
		t.Errorf("Expected body to contain 'invalid or missing agent token', got %s", rr.Body.String())
	}
}

func TestRequireAgentToken_InvalidToken(t *testing.T) {
	handler := RequireAgentToken(nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("Handler should not be called with invalid token")
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer invalid_token")
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Errorf("Expected status 401, got %d", rr.Code)
	}
}

func TestRequireAgentToken_HashesTokenCorrectly(t *testing.T) {
	token := "smithers_agent_abcdef0123456789abcdef0123456789abcdef01"
	expectedHashBytes := sha256.Sum256([]byte(token))
	expectedHashStr := hex.EncodeToString(expectedHashBytes[:])

	hashMatched := false
	mock := &mockAgentTokenQuerier{
		getWorkflowRunByAgentTokenFn: func(ctx context.Context, hash pgtype.Text) (db.WorkflowRun, error) {
			if hash.Valid && hash.String == expectedHashStr {
				hashMatched = true
			}
			return db.WorkflowRun{ID: 1}, nil
		},
	}

	handler := RequireAgentToken(mock)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if !hashMatched {
		t.Error("Expected querier to receive correct SHA-256 hash of token")
	}
}

func TestWorkflowRunFromContext_NoRun(t *testing.T) {
	run := WorkflowRunFromContext(context.Background())
	if run != nil {
		t.Errorf("Expected nil, got %v", run)
	}
}

func TestWorkflowRunFromContext_WithRun(t *testing.T) {
	expectedRun := &db.WorkflowRun{ID: 42}
	ctx := context.WithValue(context.Background(), workflowRunContextKey, expectedRun)
	run := WorkflowRunFromContext(ctx)
	if run == nil || run.ID != 42 {
		t.Errorf("Expected run with ID 42, got %v", run)
	}
}

func TestAgentTokenFromContext_NoToken(t *testing.T) {
	ctx := context.Background()
	token := AgentTokenFromContext(ctx)
	if token != "" {
		t.Errorf("Expected empty token, got %s", token)
	}
}

func TestAgentTokenFromContext_WithToken(t *testing.T) {
	expectedToken := "smithers_agent_abcdef0123456789abcdef0123456789abcdef01"
	ctx := context.WithValue(context.Background(), agentTokenContextKey, expectedToken)
	token := AgentTokenFromContext(ctx)
	if token != expectedToken {
		t.Errorf("Expected token %s, got %s", expectedToken, token)
	}
}

func TestIsValidAgentToken(t *testing.T) {
	tests := []struct {
		name  string
		token string
		want  bool
	}{
		{
			name:  "valid token",
			token: "smithers_agent_abcdef0123456789abcdef0123456789abcdef01",
			want:  true,
		},
		{
			name:  "wrong prefix - smithers_",
			token: "smithers_abcdef0123456789abcdef0123456789abcdef01",
			want:  false,
		},
		{
			name:  "wrong prefix - agent_",
			token: "agent_abcdef0123456789abcdef0123456789abcdef01",
			want:  false,
		},
		{
			name:  "no prefix",
			token: "abcdef0123456789abcdef0123456789abcdef01",
			want:  false,
		},
		{
			name:  "too short",
			token: "smithers_agent_abc",
			want:  false,
		},
		{
			name:  "too long",
			token: "smithers_agent_abcdef0123456789abcdef0123456789abcdef0123456789",
			want:  false,
		},
		{
			name:  "uppercase hex",
			token: "smithers_agent_ABCDEF0123456789ABCDEF0123456789ABCDEF01",
			want:  false,
		},
		{
			name:  "special characters",
			token: "smithers_agent_abcdef0123456789abcdef0123456789abcdefg1",
			want:  false,
		},
		{
			name:  "empty string",
			token: "",
			want:  false,
		},
		{
			name:  "just prefix",
			token: "smithers_agent_",
			want:  false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isValidAgentToken(tt.token)
			if got != tt.want {
				t.Errorf("isValidAgentToken(%q) = %v, want %v", tt.token, got, tt.want)
			}
		})
	}
}
