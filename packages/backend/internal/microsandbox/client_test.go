package microsandbox

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

func TestClientCreateVMPreservesMicrosandboxSnapshot(t *testing.T) {
	t.Parallel()
	var got sandbox.CreateRequest
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		require.NoError(t, json.NewDecoder(request.Body).Decode(&got))
		_ = json.NewEncoder(writer).Encode(sandbox.CreateResult{ID: "msb_created"})
	}))
	defer server.Close()

	client := NewClient(server.URL, "token", WithDefaultImage("fallback"))
	_, err := client.CreateSandbox(context.Background(), sandbox.CreateRequest{SnapshotID: "msbs_snapshot"})
	require.NoError(t, err)
	assert.Equal(t, "msbs_snapshot", got.SnapshotID)
}

func TestClientUsesCallerBoundIdempotencyKey(t *testing.T) {
	t.Parallel()
	var keys, kinds, ids []string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		keys = append(keys, request.Header.Get("Idempotency-Key"))
		kinds = append(kinds, request.Header.Get(sandbox.ResourceKindHeader))
		ids = append(ids, request.Header.Get(sandbox.ResourceIDHeader))
		_ = json.NewEncoder(writer).Encode(sandbox.CreateResult{ID: "msb_created"})
	}))
	defer server.Close()

	client := NewClient(server.URL, "token", WithDefaultImage("image"))
	ctx := sandbox.WithIdempotencyKey(context.Background(), "workflow-42-create")
	ctx = sandbox.WithResourceLink(ctx, "workflow_run", "42")
	_, err := client.CreateSandbox(ctx, sandbox.CreateRequest{})
	require.NoError(t, err)
	_, err = client.CreateSandbox(ctx, sandbox.CreateRequest{})
	require.NoError(t, err)
	require.Len(t, keys, 2)
	assert.Equal(t, "workflow-42-create", keys[0])
	assert.Equal(t, keys[0], keys[1])
	assert.Equal(t, []string{"workflow_run", "workflow_run"}, kinds)
	assert.Equal(t, []string{"42", "42"}, ids)
}

func TestClientCreateRetriesFailedFinalizationWithSameIdentityKey(t *testing.T) {
	t.Parallel()
	var keys []string
	attempt := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		attempt++
		keys = append(keys, request.Header.Get("Idempotency-Key"))
		writer.Header().Set("Content-Type", "application/json")
		switch attempt {
		case 1:
			writer.WriteHeader(http.StatusInternalServerError)
			_, _ = writer.Write([]byte(`{"error":{"code":"internal_error","message":"finalization failed"}}`))
		case 2:
			writer.WriteHeader(http.StatusConflict)
			_, _ = writer.Write([]byte(`{"error":{"code":"operation_in_progress","message":"awaiting worker inventory"}}`))
		default:
			writer.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(writer).Encode(sandbox.CreateResult{ID: "msb_materialized"})
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, "token", WithDefaultImage("image"))
	ctx := sandbox.WithIdempotencyKey(context.Background(), "workspace-create-stable")
	response, err := client.CreateSandbox(ctx, sandbox.CreateRequest{})
	require.NoError(t, err)
	assert.Equal(t, "msb_materialized", response.ID)
	require.Len(t, keys, 3)
	assert.NotEmpty(t, keys[0])
	assert.Equal(t, keys[0], keys[1])
	assert.Equal(t, keys[0], keys[2])
}

func TestClientTransportRetryReusesGeneratedIdempotencyKeyAndBody(t *testing.T) {
	t.Parallel()
	var keys, bodies []string
	attempts := 0
	httpClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		attempts++
		keys = append(keys, request.Header.Get("Idempotency-Key"))
		payload, err := io.ReadAll(request.Body)
		require.NoError(t, err)
		bodies = append(bodies, string(payload))
		if attempts == 1 {
			return nil, io.ErrUnexpectedEOF
		}
		return &http.Response{
			StatusCode: http.StatusCreated,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{"id":"msb_created"}`)),
			Request:    request,
		}, nil
	})}
	client := NewClient("https://controller.internal", "token", WithHTTPClient(httpClient), WithDefaultImage("image"))
	response, err := client.CreateSandbox(context.Background(), sandbox.CreateRequest{})
	require.NoError(t, err)
	assert.Equal(t, "msb_created", response.ID)
	require.Len(t, keys, 2)
	assert.NotEmpty(t, keys[0])
	assert.Equal(t, keys[0], keys[1])
	assert.Equal(t, bodies[0], bodies[1])
}

func TestSanitizeCreateRequestRedactsGitUserInfoInAnySchemeCase(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"HTTPS://user:sentinel@example.com/org/repo.git":    "HTTPS://[redacted]@example.com/org/repo.git",
		"Http://user:sentinel@example.com/org/repo.git":     "Http://[redacted]@example.com/org/repo.git",
		"https://user:sen%40tinel@example.com/org/repo.git": "https://[redacted]@example.com/org/repo.git",
		"https://user:sen@tinel@example.com/org/repo.git":   "https://[redacted]@example.com/org/repo.git",
		"https://example.com/org/repo@v1.git":               "https://example.com/org/repo@v1.git",
		"git@example.com:org/repo.git":                      "git@example.com:org/repo.git",
	}
	for raw, want := range cases {
		payload := SanitizeCreateRequest(sandbox.CreateRequest{GitRepos: []sandbox.GitRepositorySpec{{Repo: raw}}})
		var sanitized sandbox.CreateRequest
		require.NoError(t, json.Unmarshal(payload, &sanitized))
		assert.Equal(t, want, sanitized.GitRepos[0].Repo, raw)
		assert.NotContains(t, string(payload), "tinel", raw)
	}
}

func TestSanitizeCreateRequestRedactsOperationCredentials(t *testing.T) {
	t.Parallel()
	request := sandbox.CreateRequest{
		Files:    map[string]sandbox.SandboxFile{"/tmp/token": {Content: "sentinel", Executable: true}},
		GitRepos: []sandbox.GitRepositorySpec{{Repo: "https://user:sentinel@example.com/org/repo.git"}},
		Init:     &sandbox.ServiceConfig{Services: []sandbox.ServiceSpec{{Env: map[string]string{"TOKEN": "sentinel"}}}},
		EgressProxy: &sandbox.EgressProxyPolicy{Enabled: true, Secrets: []sandbox.EgressProxySecret{{
			Name: "ANTHROPIC_API_KEY", Value: "sentinel", Hosts: []string{"api.anthropic.com"}, MatchHeaders: []string{"x-api-key"},
		}}},
	}
	payload := SanitizeCreateRequest(request)
	var sanitized sandbox.CreateRequest
	require.NoError(t, json.Unmarshal(payload, &sanitized))
	assert.Equal(t, "[redacted]", sanitized.Files["/tmp/token"].Content)
	assert.True(t, sanitized.Files["/tmp/token"].Executable)
	assert.Equal(t, "https://[redacted]@example.com/org/repo.git", sanitized.GitRepos[0].Repo)
	assert.Equal(t, "[redacted]", sanitized.Init.Services[0].Env["TOKEN"])
	require.Len(t, sanitized.EgressProxy.Secrets, 1)
	assert.Equal(t, "[redacted]", sanitized.EgressProxy.Secrets[0].Value)
	assert.Equal(t, "ANTHROPIC_API_KEY", sanitized.EgressProxy.Secrets[0].Name, "the binding declaration survives for recovery")
	assert.Equal(t, []string{"api.anthropic.com"}, sanitized.EgressProxy.Secrets[0].Hosts)
	assert.NotContains(t, string(payload), "sentinel")
	// The caller's request is untouched: the worker still needs the values once.
	assert.Equal(t, "sentinel", request.EgressProxy.Secrets[0].Value)
}
