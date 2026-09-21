package microsandbox

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	. "github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

type mockAPIRequestObserver struct {
	method   string
	endpoint string
	seconds  float64

	errorEndpoint string
	errorCode     string
}

func (m *mockAPIRequestObserver) ObserveSandboxAPIRequest(method, endpoint string, seconds float64) {
	m.method = method
	m.endpoint = endpoint
	m.seconds = seconds
}

func (m *mockAPIRequestObserver) IncSandboxAPIErrors(endpoint, errorCode string) {
	m.errorEndpoint = endpoint
	m.errorCode = errorCode
}

func TestClient_CreateVM_SendsBearerHeaderAndJSON(t *testing.T) {
	t.Parallel()

	var authHeader string
	var contentType string
	var reqBody CreateRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Equal(t, "/v1/sandboxes", r.URL.Path)

		authHeader = r.Header.Get("Authorization")
		contentType = r.Header.Get("Content-Type")

		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		require.NoError(t, json.Unmarshal(body, &reqBody))

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"vm_123"}`))
	}))
	defer server.Close()

	waitForReady := true
	idleTimeout := int64(1800)
	client := NewClient(server.URL, "secret-api-key")

	resp, err := client.CreateSandbox(context.Background(), CreateRequest{
		SnapshotID:         "snap_123",
		WaitForReady:       &waitForReady,
		IdleTimeoutSeconds: &idleTimeout,
		Files: map[string]SandboxFile{
			"/tmp/test.txt": {Content: "hello"},
		},
	})
	require.NoError(t, err)

	assert.Equal(t, "Bearer secret-api-key", authHeader)
	assert.Equal(t, "application/json", contentType)
	assert.Equal(t, "snap_123", reqBody.SnapshotID)
	require.NotNil(t, reqBody.WaitForReady)
	assert.True(t, *reqBody.WaitForReady)
	require.NotNil(t, reqBody.IdleTimeoutSeconds)
	assert.EqualValues(t, 1800, *reqBody.IdleTimeoutSeconds)
	assert.Equal(t, "hello", reqBody.Files["/tmp/test.txt"].Content)

	assert.Equal(t, "vm_123", resp.ID)
}

func TestClient_ParsesStructuredProviderError(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":{"code":"stale_generation","message":"placement changed"}}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "")
	_, err := client.InspectSandbox(context.Background(), "msb_vm")
	var statusErr *StatusError
	require.ErrorAs(t, err, &statusErr)
	assert.Equal(t, "stale_generation", statusErr.ErrorCode)
	assert.Equal(t, "stale_generation", statusErr.Code)
	assert.Equal(t, "placement changed", statusErr.Message)
	assert.Equal(t, ProviderMicrosandbox, statusErr.Provider)
}

// A 2xx create whose body carries the sandbox id but fails to decode means the
// sandbox exists server-side. The client must reap it and never hand the
// partial id or leaked sandbox to the caller.
func TestClient_CreateVM_PartialResponseReapsVM(t *testing.T) {
	t.Parallel()

	var deletedPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			assert.Equal(t, "/v1/sandboxes", r.URL.Path)
			w.Header().Set("Content-Type", "application/json")
			// The id decodes before the following field fails type validation,
			// so the response object is partially populated when Decode errors.
			_, _ = w.Write([]byte(`{"id":"vm_partial","id":123}`))
		case http.MethodDelete:
			deletedPath = r.URL.Path
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected method %s", r.Method)
		}
	}))
	defer server.Close()

	client := NewClient(server.URL, "secret-api-key")
	resp, err := client.CreateSandbox(context.Background(), CreateRequest{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "decode microsandbox response")
	assert.Empty(t, resp.ID, "a failed create must never surface a partial sandbox id")
	assert.Equal(t, "/v1/sandboxes/vm_partial", deletedPath, "the partially created sandbox must be reaped")
}

func TestClient_GetVM_ParsesResponse(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodGet, r.Method)
		assert.Equal(t, "/v1/sandboxes/vm_abc", r.URL.Path)

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"vm_abc","runtimeId":"inst_123","state":"running","cpuTimeSeconds":12.5}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "secret-api-key")
	resp, err := client.InspectSandbox(context.Background(), "vm_abc")
	require.NoError(t, err)

	assert.Equal(t, "vm_abc", resp.ID)
	assert.Equal(t, "inst_123", resp.RuntimeID)
	assert.Equal(t, StateRunning, resp.State)
	require.NotNil(t, resp.CPUTimeSeconds)
	assert.Equal(t, 12.5, *resp.CPUTimeSeconds)
}

func TestClient_ForkVM_UsesForkAPIPath(t *testing.T) {
	t.Parallel()

	var reqBody ForkRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Equal(t, "/v1/sandboxes/vm_source/fork", r.URL.Path)

		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		require.NoError(t, json.Unmarshal(body, &reqBody))

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"vm_forked"}`))
	}))
	defer server.Close()

	idleTimeout := int64(900)
	priority := int32(7)
	client := NewClient(server.URL, "secret-api-key")
	resp, err := client.ForkSandbox(context.Background(), "vm_source", ForkRequest{
		IdleTimeoutSeconds: &idleTimeout,
		Persistence: &PersistencePolicy{
			Type:     PersistencePersistent,
			Priority: &priority,
		},
		Workdir: "/home/developer/workspace",
	})
	require.NoError(t, err)

	require.NotNil(t, reqBody.IdleTimeoutSeconds)
	assert.EqualValues(t, 900, *reqBody.IdleTimeoutSeconds)
	require.NotNil(t, reqBody.Persistence)
	assert.Equal(t, PersistencePersistent, reqBody.Persistence.Type)
	require.NotNil(t, reqBody.Persistence.Priority)
	assert.EqualValues(t, 7, *reqBody.Persistence.Priority)
	assert.Equal(t, "/home/developer/workspace", reqBody.Workdir)
	assert.Equal(t, "vm_forked", resp.ID)
}

func TestClient_ExecAwait_ParsesResponse(t *testing.T) {
	t.Parallel()

	var reqBody ExecRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Equal(t, "/v1/sandboxes/vm_exec/exec", r.URL.Path)

		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		require.NoError(t, json.Unmarshal(body, &reqBody))

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"stdout":"ok\n","stderr":"","statusCode":0}`))
	}))
	defer server.Close()

	timeoutMS := int64(5000)
	client := NewClient(server.URL, "secret-api-key")
	resp, err := client.Execute(context.Background(), "vm_exec", ExecRequest{
		Command:   "echo ok",
		TimeoutMS: &timeoutMS,
	})
	require.NoError(t, err)

	assert.Equal(t, "echo ok", reqBody.Command)
	require.NotNil(t, reqBody.TimeoutMS)
	assert.EqualValues(t, 5000, *reqBody.TimeoutMS)
	assert.Equal(t, "ok\n", resp.Stdout)
	require.NotNil(t, resp.StatusCode)
	assert.EqualValues(t, 0, *resp.StatusCode)
}

func TestClient_StatusError_ParsesStructuredError(t *testing.T) {
	t.Parallel()

	observer := &mockAPIRequestObserver{}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"error":"UPSTREAM_DOWN","message":"backend unavailable"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "secret-api-key", WithAPIRequestObserver(observer))
	_, err := client.InspectSandbox(context.Background(), "vm_fail")
	require.Error(t, err)

	var statusErr *StatusError
	require.ErrorAs(t, err, &statusErr)
	assert.Equal(t, http.StatusBadGateway, statusErr.StatusCode)
	assert.Equal(t, "UPSTREAM_DOWN", statusErr.ErrorCode)
	assert.Equal(t, "backend unavailable", statusErr.Message)

	// Metric labels must stay low-cardinality: templated endpoint (no VM ID)
	// and a closed error-code enum (never the server's free-form string).
	assert.Equal(t, "/v1/sandboxes/{id}", observer.endpoint)
	assert.Equal(t, "/v1/sandboxes/{id}", observer.errorEndpoint)
	assert.Equal(t, "server_error", observer.errorCode)
}

func TestClient_CreateIdentityToken_UsesIdentityAPIPath(t *testing.T) {
	t.Parallel()

	var authHeader string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Equal(t, "/v1/access/identities/ident_123/tokens", r.URL.Path)
		authHeader = r.Header.Get("Authorization")

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"tok_123","token":"ssh-token-value"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "secret-api-key")
	resp, err := client.CreateIdentityToken(context.Background(), "ident_123")
	require.NoError(t, err)

	assert.Equal(t, "Bearer secret-api-key", authHeader)
	assert.Equal(t, "tok_123", resp.ID)
	assert.Equal(t, "ssh-token-value", resp.Token)
}

func TestClient_GrantVMPermission_SendsAllowedUsers(t *testing.T) {
	t.Parallel()

	var reqBody GrantAccessRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Equal(t, "/v1/access/identities/ident_123/permissions/sandbox/vm_123", r.URL.Path)

		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		require.NoError(t, json.Unmarshal(body, &reqBody))

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"allowedUsers":["developer"]}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "secret-api-key")
	resp, err := client.GrantAccess(context.Background(), "ident_123", "vm_123", GrantAccessRequest{
		AllowedUsers: []string{"developer"},
	})
	require.NoError(t, err)

	assert.Equal(t, []string{"developer"}, reqBody.AllowedUsers)
	assert.Equal(t, []string{"developer"}, resp.AllowedUsers)
}

func TestClient_DeleteSnapshot_UsesSnapshotAPIPath(t *testing.T) {
	t.Parallel()

	var authHeader string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodDelete, r.Method)
		assert.Equal(t, "/v1/sandboxes/snapshots/snap_123", r.URL.Path)
		authHeader = r.Header.Get("Authorization")

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"deleted":true}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "secret-api-key")
	err := client.DeleteSnapshot(context.Background(), "snap_123")
	require.NoError(t, err)

	assert.Equal(t, "Bearer secret-api-key", authHeader)
}

func TestEscapeGuestPathRejectsTraversalAndEscapesEachSegment(t *testing.T) {
	t.Parallel()
	for _, unsafe := range []string{"", "/", "../etc/passwd", "/tmp/../etc", "/tmp//file", "/./file", "//etc/passwd", "a/\x00b"} {
		_, err := EscapeGuestPath(unsafe)
		assert.Error(t, err, unsafe)
	}
	escaped, err := EscapeGuestPath("/workspace/a file/#config")
	require.NoError(t, err)
	assert.Equal(t, "workspace/a%20file/%23config", escaped)
}
