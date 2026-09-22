package client

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNew_ValidatesConfig(t *testing.T) {
	t.Parallel()

	_, err := New(Config{})
	require.Error(t, err)

	_, err = New(Config{BaseURL: "http://example.com"})
	require.Error(t, err)

	client, err := New(Config{BaseURL: "http://example.com/internal/", Token: "token"})
	require.NoError(t, err)
	assert.Equal(t, "http://example.com", client.baseURL)
}

func TestClient_Register(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/internal/runners/register", r.URL.Path)
		assert.Equal(t, "Bearer token", r.Header.Get("Authorization"))

		var req struct {
			Name     string          `json:"name"`
			Metadata json.RawMessage `json:"metadata"`
		}
		require.NoError(t, json.NewDecoder(r.Body).Decode(&req))
		assert.Equal(t, "runner-1", req.Name)
		assert.JSONEq(t, `{"pod":"runner-1"}`, string(req.Metadata))

		require.NoError(t, json.NewEncoder(w).Encode(RegisterResponse{RunnerID: 41}))
	}))
	defer server.Close()

	client, err := New(Config{BaseURL: server.URL, Token: "token"})
	require.NoError(t, err)

	resp, err := client.Register(context.Background(), "runner-1", json.RawMessage(`{"pod":"runner-1"}`))
	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, int64(41), resp.RunnerID)
}

func TestClient_ClaimTask(t *testing.T) {
	t.Parallel()

	t.Run("returns task on 200", func(t *testing.T) {
		t.Parallel()

		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assert.Equal(t, "/internal/runners/7/claim", r.URL.Path)
			require.NoError(t, json.NewEncoder(w).Encode(Task{
				ID:             9,
				WorkflowRunID:  10,
				RepositoryID:   11,
				WorkflowStepID: 12,
				Attempt:        3,
				Payload:        json.RawMessage(`{"job":"build"}`),
			}))
		}))
		defer server.Close()

		client, err := New(Config{BaseURL: server.URL, Token: "token"})
		require.NoError(t, err)

		task, err := client.ClaimTask(context.Background(), 7)
		require.NoError(t, err)
		require.NotNil(t, task)
		assert.Equal(t, int64(11), task.RepositoryID)
		assert.Equal(t, int64(12), task.WorkflowStepID)
		assert.Equal(t, int32(3), task.Attempt)
	})

	t.Run("returns nil on 204", func(t *testing.T) {
		t.Parallel()

		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		}))
		defer server.Close()

		client, err := New(Config{BaseURL: server.URL, Token: "token"})
		require.NoError(t, err)

		task, err := client.ClaimTask(context.Background(), 7)
		require.NoError(t, err)
		assert.Nil(t, task)
	})
}

func TestClient_GetTaskStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/internal/tasks/9/status", r.URL.Path)
		assert.Equal(t, "7", r.URL.Query().Get("runner_id"))
		assert.Equal(t, "Bearer token", r.Header.Get("Authorization"))
		_, _ = w.Write([]byte(`{"status":"cancelled"}`))
	}))
	defer server.Close()
	client, err := New(Config{BaseURL: server.URL, Token: "token"})
	require.NoError(t, err)
	status, err := client.GetTaskStatus(context.Background(), 9, 7)
	require.NoError(t, err)
	assert.Equal(t, "cancelled", status)
}

func TestClient_Heartbeat(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/internal/runners/3/heartbeat", r.URL.Path)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client, err := New(Config{BaseURL: server.URL, Token: "token"})
	require.NoError(t, err)

	require.NoError(t, client.Heartbeat(context.Background(), 3))
}

func TestClient_CompleteTask(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/internal/tasks/22/complete", r.URL.Path)

		var req struct {
			RunnerID int64  `json:"runner_id"`
			Status   string `json:"status"`
			Error    string `json:"error"`
		}
		require.NoError(t, json.NewDecoder(r.Body).Decode(&req))
		assert.Equal(t, int64(7), req.RunnerID)
		assert.Equal(t, "failed", req.Status)
		assert.Equal(t, "boom", req.Error)

		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client, err := New(Config{BaseURL: server.URL, Token: "token"})
	require.NoError(t, err)

	require.NoError(t, client.CompleteTask(context.Background(), 22, 7, "failed", "boom"))
}

func TestClient_TerminateRunner(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/internal/runners/15/terminate", r.URL.Path)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client, err := New(Config{BaseURL: server.URL, Token: "token"})
	require.NoError(t, err)

	require.NoError(t, client.TerminateRunner(context.Background(), 15))
}
