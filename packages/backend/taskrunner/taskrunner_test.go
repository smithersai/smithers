package taskrunner_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/smithersai/smithers/packages/backend/taskrunner"
	"github.com/stretchr/testify/require"
)

func TestClientPoolCarriesCanonicalTaskAndRejectsCredentialFailure(t *testing.T) {
	var completed atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer real-contract-token" {
			w.WriteHeader(401)
			return
		}
		switch r.URL.Path {
		case "/internal/runners/7/claim":
			require.Equal(t, http.MethodPost, r.Method)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": 12, "workflow_run_id": 13, "repository_id": 14, "workflow_step_id": 15, "attempt": 2, "payload": map[string]string{"kind": "fixture"}})
		case "/internal/tasks/12/complete":
			var body map[string]any
			require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
			require.Equal(t, float64(7), body["runner_id"])
			require.Equal(t, "done", body["status"])
			completed.Store(true)
			w.WriteHeader(204)
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	client, err := taskrunner.NewClient(taskrunner.ClientConfig{BaseURL: server.URL, Token: "real-contract-token"})
	require.NoError(t, err)
	pool := taskrunner.NewAPIPool(client)
	task, err := pool.ClaimTask(context.Background(), 7)
	require.NoError(t, err)
	require.NotNil(t, task)
	require.Equal(t, int64(14), task.RepositoryID)
	require.Equal(t, int32(2), task.Attempt)
	require.NoError(t, pool.CompleteTask(context.Background(), task.ID, 7, "done", ""))
	require.True(t, completed.Load())
	refused, err := taskrunner.NewClient(taskrunner.ClientConfig{BaseURL: server.URL, Token: "wrong-token"})
	require.NoError(t, err)
	_, err = taskrunner.NewAPIPool(refused).ClaimTask(context.Background(), 7)
	require.ErrorContains(t, err, "401")
}
