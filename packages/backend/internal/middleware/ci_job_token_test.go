package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type fakeCIJobTokens struct {
	rows map[string]db.GetWorkflowRunByTaskGuestTokenRow
}

func (f fakeCIJobTokens) GetWorkflowRunByTaskGuestToken(_ context.Context, hash string) (db.GetWorkflowRunByTaskGuestTokenRow, error) {
	row, ok := f.rows[hash]
	if !ok {
		return db.GetWorkflowRunByTaskGuestTokenRow{}, pgx.ErrNoRows
	}
	return row, nil
}

func ciJobRequest(t *testing.T, tokens fakeCIJobTokens, token string) (int, *db.WorkflowRun, int64) {
	t.Helper()
	var run *db.WorkflowRun
	var taskID int64
	wrapped := RequireWorkflowRunCredential(&mockAgentTokenQuerier{
		getWorkflowRunByAgentTokenFn: func(context.Context, pgtype.Text) (db.WorkflowRun, error) {
			return db.WorkflowRun{ID: 7, Status: "running"}, nil
		},
	}, tokens)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		run = WorkflowRunFromContext(r.Context())
		taskID = CIJobTaskIDFromContext(r.Context())
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodPost, "/internal/caches/restore", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	wrapped.ServeHTTP(rec, req)
	return rec.Code, run, taskID
}

func TestRequireWorkflowRunCredential_JobToken(t *testing.T) {
	live := CIJobTokenPrefix + strings.Repeat("a", 40)
	expired := CIJobTokenPrefix + strings.Repeat("b", 40)
	finished := CIJobTokenPrefix + strings.Repeat("c", 40)
	terminal := CIJobTokenPrefix + strings.Repeat("d", 40)
	future := time.Now().Add(time.Hour)
	tokens := fakeCIJobTokens{rows: map[string]db.GetWorkflowRunByTaskGuestTokenRow{
		HashCIJobToken(live):     {WorkflowRun: db.WorkflowRun{ID: 42, RepositoryID: 100, Status: "running"}, WorkflowTaskID: 5, TaskStatus: "running", TokenExpiresAt: future},
		HashCIJobToken(expired):  {WorkflowRun: db.WorkflowRun{ID: 42, Status: "running"}, TaskStatus: "running", TokenExpiresAt: time.Now().Add(-time.Second)},
		HashCIJobToken(finished): {WorkflowRun: db.WorkflowRun{ID: 42, Status: "running"}, TaskStatus: "done", TokenExpiresAt: future},
		HashCIJobToken(terminal): {WorkflowRun: db.WorkflowRun{ID: 42, Status: "cancelled"}, TaskStatus: "running", TokenExpiresAt: future},
	}}

	code, run, taskID := ciJobRequest(t, tokens, live)
	require.Equal(t, http.StatusNoContent, code)
	require.NotNil(t, run)
	assert.Equal(t, int64(42), run.ID, "the job token resolves to its own run")
	assert.Equal(t, int64(100), run.RepositoryID)
	assert.Equal(t, int64(5), taskID)

	for name, token := range map[string]string{
		"expired":         expired,
		"task finished":   finished,
		"run terminal":    terminal,
		"never issued":    CIJobTokenPrefix + strings.Repeat("e", 40),
		"malformed":       CIJobTokenPrefix + "not-hex",
		"uppercase hex":   CIJobTokenPrefix + strings.Repeat("A", 40),
		"wrong length":    CIJobTokenPrefix + strings.Repeat("a", 39),
		"prefix only":     CIJobTokenPrefix,
		"agent-shaped":    "smithers_agent_" + strings.Repeat("z", 40),
		"arbitrary token": "hello",
	} {
		code, run, _ := ciJobRequest(t, tokens, token)
		assert.Equal(t, http.StatusUnauthorized, code, name)
		assert.Nil(t, run, name)
	}

	// A per-run agent token still works on the same routes.
	code, run, taskID = ciJobRequest(t, tokens, "smithers_agent_"+strings.Repeat("0", 40))
	require.Equal(t, http.StatusNoContent, code)
	assert.Equal(t, int64(7), run.ID)
	assert.Zero(t, taskID)
}

// RequireAgentToken guards agent-session and model-proxy routes; a job token
// must never pass it.
func TestRequireAgentToken_RejectsJobTokens(t *testing.T) {
	called := false
	handler := RequireAgentToken(&mockAgentTokenQuerier{
		getWorkflowRunByAgentTokenFn: func(context.Context, pgtype.Text) (db.WorkflowRun, error) {
			called = true
			return db.WorkflowRun{ID: 1, Status: "running"}, nil
		},
	})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	req.Header.Set("Authorization", "Bearer "+CIJobTokenPrefix+strings.Repeat("a", 40))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.False(t, called)
}
