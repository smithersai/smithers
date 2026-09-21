package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestAgentToken_Cov_ValidTokenWithNilQuerierReturnsInternal(t *testing.T) {
	t.Setenv("SMITHERS_AGENT_TOKEN", "")

	nextCalled := false
	handler := RequireAgentToken(nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusNoContent)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer smithers_agent_0000000000000000000000000000000000000000")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	assert.Equal(t, http.StatusInternalServerError, rec.Code)
	assert.False(t, nextCalled)
	assert.Contains(t, rec.Body.String(), "internal server error")
}

func TestAgentToken_Cov_ContextHelpersRoundTrip(t *testing.T) {
	t.Parallel()

	run := &db.WorkflowRun{ID: 77}
	token := "smithers_agent_1111111111111111111111111111111111111111"

	ctx := ContextWithWorkflowRun(context.Background(), run)
	ctx = ContextWithAgentToken(ctx, token)

	require.Same(t, run, WorkflowRunFromContext(ctx))
	assert.Equal(t, token, AgentTokenFromContext(ctx))
	assert.True(t, strings.HasPrefix(AgentTokenFromContext(ctx), "smithers_agent_"))
}
