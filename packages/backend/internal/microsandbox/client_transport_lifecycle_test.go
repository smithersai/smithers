package microsandbox

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	. "github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

func TestClientRevokeAccessGrantCallsControllerRoute(t *testing.T) {
	t.Parallel()
	called := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, http.MethodDelete, r.Method)
		require.Equal(t, "/v1/sandboxes/vm-target/access-grants", r.URL.Path)
		require.Equal(t, "revoke-key", r.Header.Get("Idempotency-Key"))
		called <- struct{}{}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := NewClient(server.URL, "test-key")
	ctx := WithIdempotencyKey(context.Background(), "revoke-key")
	require.NoError(t, client.RevokeAccessGrant(ctx, "vm-target"))
	select {
	case <-called:
	case <-time.After(time.Second):
		t.Fatal("controller revocation route was not called within the bound")
	}
}

// TestClient_VMLifecycle_CreateRunCompleteDelete exercises the full mock VM
// lifecycle that agent dispatch follows: create -> get (running) -> exec -> delete.
func TestClient_VMLifecycle_CreateRunCompleteDelete(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	calls := make([]string, 0, 4)
	vmState := StateStarting

	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/sandboxes", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls = append(calls, "create")
		vmState = StateRunning
		mu.Unlock()

		var req CreateRequest
		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		require.NoError(t, json.Unmarshal(body, &req))

		assert.Equal(t, "snap-agent-123", req.SnapshotID)
		require.NotNil(t, req.Persistence)
		assert.Equal(t, PersistenceEphemeral, req.Persistence.Type)

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(CreateResult{ID: "vm-lifecycle-001"})
	})

	mux.HandleFunc("GET /v1/sandboxes/vm-lifecycle-001", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls = append(calls, "get")
		state := vmState
		mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(Sandbox{
			ID:    "vm-lifecycle-001",
			State: state,
		})
	})

	mux.HandleFunc("POST /v1/sandboxes/vm-lifecycle-001/exec", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls = append(calls, "exec")
		mu.Unlock()

		var req ExecRequest
		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		require.NoError(t, json.Unmarshal(body, &req))

		exitCode := int32(0)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(ExecResult{
			Stdout:     "hello from VM\n",
			Stderr:     "",
			StatusCode: &exitCode,
		})
	})

	mux.HandleFunc("DELETE /v1/sandboxes/vm-lifecycle-001", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls = append(calls, "delete")
		vmState = StateStopped
		mu.Unlock()

		w.WriteHeader(http.StatusNoContent)
	})

	server := httptest.NewServer(mux)
	defer server.Close()

	client := NewClient(server.URL, "test-api-key")
	ctx := context.Background()

	// 1. Create VM
	deleteOnStop := DeleteOnStop
	waitForReady := false
	createResp, err := client.CreateSandbox(ctx, CreateRequest{
		SnapshotID:   "snap-agent-123",
		WaitForReady: &waitForReady,
		Persistence: &PersistencePolicy{
			Type:        PersistenceEphemeral,
			DeleteEvent: &deleteOnStop,
		},
	})
	require.NoError(t, err)
	assert.Equal(t, "vm-lifecycle-001", createResp.ID)

	// 2. Get VM (verify running)
	getResp, err := client.InspectSandbox(ctx, createResp.ID)
	require.NoError(t, err)
	assert.Equal(t, StateRunning, getResp.State)

	// 3. Exec command
	execResp, err := client.Execute(ctx, createResp.ID, ExecRequest{
		Command: "echo hello from VM",
	})
	require.NoError(t, err)
	assert.Equal(t, "hello from VM\n", execResp.Stdout)
	require.NotNil(t, execResp.StatusCode)
	assert.EqualValues(t, 0, *execResp.StatusCode)

	// 4. Delete VM
	err = client.DeleteSandbox(ctx, createResp.ID)
	require.NoError(t, err)

	mu.Lock()
	assert.Equal(t, []string{"create", "get", "exec", "delete"}, calls)
	mu.Unlock()
}

// TestClient_CreateVM_WithSnapshotAndSystemd verifies the agent dispatch VM
// request shape: snapshot ID, git repos, systemd service, ephemeral persistence.
func TestClient_CreateVM_WithSnapshotAndSystemd(t *testing.T) {
	t.Parallel()

	var capturedReq CreateRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		require.NoError(t, json.Unmarshal(body, &capturedReq))

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(CreateResult{ID: "vm-snapshot-sys"})
	}))
	defer server.Close()

	client := NewClient(server.URL, "test-key")

	idleTimeout := int64(300)
	waitForReady := false
	deleteOnStop := DeleteOnStop
	memMB := int32(4096)
	vcpu := int32(2)
	rootfs := int64(10240)

	resp, err := client.CreateSandbox(context.Background(), CreateRequest{
		SnapshotID:         "agent-snap-456",
		IdleTimeoutSeconds: &idleTimeout,
		WaitForReady:       &waitForReady,
		MemSizeMB:          &memMB,
		VCPUCount:          &vcpu,
		RootfsSizeMB:       &rootfs,
		Persistence: &PersistencePolicy{
			Type:        PersistenceEphemeral,
			DeleteEvent: &deleteOnStop,
		},
		GitRepos: []GitRepositorySpec{
			{
				Repo: "https://smithers:token123@smithers.test/alice/demo.git",
				Path: "/workspace",
			},
		},
		Workdir: "/workspace",
	})
	require.NoError(t, err)
	assert.Equal(t, "vm-snapshot-sys", resp.ID)

	// Verify the full request shape
	assert.Equal(t, "agent-snap-456", capturedReq.SnapshotID)
	require.NotNil(t, capturedReq.IdleTimeoutSeconds)
	assert.EqualValues(t, 300, *capturedReq.IdleTimeoutSeconds)
	require.NotNil(t, capturedReq.WaitForReady)
	assert.False(t, *capturedReq.WaitForReady)
	require.NotNil(t, capturedReq.MemSizeMB)
	assert.EqualValues(t, 4096, *capturedReq.MemSizeMB)
	require.NotNil(t, capturedReq.VCPUCount)
	assert.EqualValues(t, 2, *capturedReq.VCPUCount)
	require.NotNil(t, capturedReq.RootfsSizeMB)
	assert.EqualValues(t, 10240, *capturedReq.RootfsSizeMB)
	require.NotNil(t, capturedReq.Persistence)
	assert.Equal(t, PersistenceEphemeral, capturedReq.Persistence.Type)
	require.Len(t, capturedReq.GitRepos, 1)
	assert.Equal(t, "/workspace", capturedReq.GitRepos[0].Path)
	assert.Contains(t, capturedReq.GitRepos[0].Repo, "alice/demo.git")
	assert.Equal(t, "/workspace", capturedReq.Workdir)
}

// TestClient_CreateSystemdService_SendsUnitSpec verifies the systemd service
// creation API call used after VM creation in agent dispatch.
func TestClient_CreateSystemdService_SendsUnitSpec(t *testing.T) {
	t.Parallel()

	var capturedReq ServiceSpec
	var capturedVMID string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Equal(t, "/v1/sandboxes/vm-agent-789/services", r.URL.Path)

		capturedVMID = "vm-agent-789"

		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		require.NoError(t, json.Unmarshal(body, &capturedReq))

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(CreateServiceResult{
			Success:     true,
			ServiceName: capturedReq.Name,
			Message:     "created",
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "test-key")

	resp, err := client.CreateService(context.Background(), "vm-agent-789", ServiceSpec{
		Name: "smithers-agent",
		Mode: ServiceModeService,
		Exec: []string{"/usr/local/bin/bun run ./agent.ts"},
		Env: map[string]string{
			"HOME":                      "/root",
			"SMITHERS_AGENT_SESSION_ID": "sess-123",
			"SMITHERS_AGENT_TOKEN":      "smithers_agent_token",
			"SMITHERS_API_BASE_URL":     "https://api.smithers.sh",
			"SMITHERS_REPOSITORY_PATH":  "/workspace",
			"PATH":                      "/usr/local/bin:/root/.bun/bin:/usr/bin:/bin",
		},
		Workdir: "/opt/smithers/runner-workflow",
	})
	require.NoError(t, err)

	assert.Equal(t, "vm-agent-789", capturedVMID)
	assert.True(t, resp.Success)
	assert.Equal(t, "smithers-agent", resp.ServiceName)

	assert.Equal(t, "smithers-agent", capturedReq.Name)
	assert.Equal(t, ServiceModeService, capturedReq.Mode)
	require.Len(t, capturedReq.Exec, 1)
	assert.Equal(t, "/usr/local/bin/bun run ./agent.ts", capturedReq.Exec[0])
	assert.Equal(t, "/opt/smithers/runner-workflow", capturedReq.Workdir)
	assert.Equal(t, "/root", capturedReq.Env["HOME"])
	assert.Equal(t, "sess-123", capturedReq.Env["SMITHERS_AGENT_SESSION_ID"])
	assert.Equal(t, "smithers_agent_token", capturedReq.Env["SMITHERS_AGENT_TOKEN"])
	assert.Equal(t, "https://api.smithers.sh", capturedReq.Env["SMITHERS_API_BASE_URL"])
	assert.Equal(t, "/workspace", capturedReq.Env["SMITHERS_REPOSITORY_PATH"])
}

// TestClient_CreateVM_ErrorReturnsParsedStatusError verifies that a sandbox
// API error during VM creation is correctly parsed and surfaced.
func TestClient_CreateVM_ErrorReturnsParsedStatusError(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"error":"CAPACITY_EXHAUSTED","message":"no available hosts"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "test-key")
	_, err := client.CreateSandbox(context.Background(), CreateRequest{
		SnapshotID: "snap-fail",
	})
	require.Error(t, err)

	var statusErr *StatusError
	require.ErrorAs(t, err, &statusErr)
	assert.Equal(t, http.StatusServiceUnavailable, statusErr.StatusCode)
	assert.Equal(t, "CAPACITY_EXHAUSTED", statusErr.ErrorCode)
	assert.Equal(t, "no available hosts", statusErr.Message)
}

// TestClient_DeleteVM_404IsStillAnError verifies that a 404 on DeleteSandbox returns
// an error (the agent reaper checks for this specifically).
func TestClient_DeleteVM_404IsStillAnError(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"NOT_FOUND","message":"vm not found"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "test-key")
	err := client.DeleteSandbox(context.Background(), "vm-gone")
	require.Error(t, err)

	var statusErr *StatusError
	require.ErrorAs(t, err, &statusErr)
	assert.Equal(t, http.StatusNotFound, statusErr.StatusCode)
}

// TestClient_SuspendVM_ReturnsSnapshotLayerID verifies the suspend response
// parsing used by workspace lifecycle.
func TestClient_SuspendVM_ReturnsSnapshotLayerID(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Equal(t, "/v1/sandboxes/vm-suspend-test/suspend", r.URL.Path)

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(SuspendResult{
			ID:                "vm-suspend-test",
			RuntimeID:         "inst-456",
			RuntimeSnapshotID: "snap-layer-789",
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "test-key")
	resp, err := client.SuspendSandbox(context.Background(), "vm-suspend-test")
	require.NoError(t, err)

	assert.Equal(t, "vm-suspend-test", resp.ID)
	assert.Equal(t, "inst-456", resp.RuntimeID)
	assert.Equal(t, "snap-layer-789", resp.RuntimeSnapshotID)
}

// TestClient_StartVM_ReturnsIngressDetails verifies the resume/start response
// used by workspace resume flow.
func TestClient_StartVM_ReturnsIngressDetails(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Equal(t, "/v1/sandboxes/vm-start-test/start", r.URL.Path)

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(StartResult{
			ID:        "vm-start-test",
			RuntimeID: "inst-789",
			GuestIP:   "10.0.0.5",
			HostIP:    "192.168.1.100",
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "test-key")
	resp, err := client.StartSandbox(context.Background(), "vm-start-test", StartRequest{})
	require.NoError(t, err)

	assert.Equal(t, "vm-start-test", resp.ID)
	assert.Equal(t, "inst-789", resp.RuntimeID)
	assert.Equal(t, "10.0.0.5", resp.GuestIP)
}

// TestClient_WriteFile_UsesCorrectPath verifies the file write API used for
// injecting config files into VMs.
func TestClient_WriteFile_UsesCorrectPath(t *testing.T) {
	t.Parallel()

	var capturedPath string
	var capturedContent string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPut, r.Method)
		capturedPath = r.URL.Path

		var req WriteFileRequest
		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		require.NoError(t, json.Unmarshal(body, &req))
		capturedContent = req.Content

		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := NewClient(server.URL, "test-key")
	err := client.WriteFile(context.Background(), "vm-write-test", "/etc/smithers/config.json", WriteFileRequest{
		Content: `{"key":"value"}`,
	})
	require.NoError(t, err)

	assert.Equal(t, "/v1/sandboxes/vm-write-test/files/etc/smithers/config.json", capturedPath)
	assert.Equal(t, `{"key":"value"}`, capturedContent)
}

// TestClient_SnapshotVM_ParsesResponse verifies snapshot creation used by
// workspace snapshot flow.
func TestClient_SnapshotVM_ParsesResponse(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Equal(t, "/v1/sandboxes/vm-snap-test/snapshot", r.URL.Path)

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(SnapshotResult{
			SnapshotID:      "snap-created-123",
			SourceSandboxID: "vm-snap-test",
			SourceRuntimeID: "inst-456",
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "test-key")
	resp, err := client.SnapshotSandbox(context.Background(), "vm-snap-test", SnapshotRequest{
		Name: "test-snapshot",
	})
	require.NoError(t, err)

	assert.Equal(t, "snap-created-123", resp.SnapshotID)
	assert.Equal(t, "vm-snap-test", resp.SourceSandboxID)
}

// TestClient_CreateSnapshot_FromTemplate verifies template-based snapshot
// creation used for base layer caching.
func TestClient_CreateSnapshot_FromTemplate(t *testing.T) {
	t.Parallel()

	var capturedReq CreateSnapshotRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, http.MethodPost, r.Method)
		assert.Equal(t, "/v1/sandboxes/snapshots", r.URL.Path)

		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		require.NoError(t, json.Unmarshal(body, &capturedReq))

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(CreateSnapshotResponse{
			SnapshotID: "snap-template-999",
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "test-key")
	resp, err := client.CreateSnapshot(context.Background(), CreateSnapshotRequest{
		Name: "smithers-agent-base",
		Template: Template{
			Packages: []string{"curl", "unzip", "git"},
			Workdir:  "/workspace",
		},
	})
	require.NoError(t, err)

	assert.Equal(t, "snap-template-999", resp.SnapshotID)
	assert.Equal(t, "smithers-agent-base", capturedReq.Name)
	assert.Equal(t, []string{"curl", "unzip", "git"}, capturedReq.Template.Packages)
	assert.Equal(t, "/workspace", capturedReq.Template.Workdir)
}

// TestClient_CreateIdentity_AndGrantPermission verifies the identity flow used
// by workspace SSH access provisioning.
func TestClient_CreateIdentity_AndGrantPermission(t *testing.T) {
	t.Parallel()

	callOrder := make([]string, 0, 3)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/access/identities", func(w http.ResponseWriter, r *http.Request) {
		callOrder = append(callOrder, "create_identity")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(Identity{
			ID:      "ident-new-456",
			Managed: true,
		})
	})
	mux.HandleFunc("POST /v1/access/identities/ident-new-456/permissions/sandbox/vm-target-789", func(w http.ResponseWriter, r *http.Request) {
		callOrder = append(callOrder, "grant_permission")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(AccessGrant{
			ID:           "perm-granted",
			AllowedUsers: []string{"developer"},
		})
	})
	mux.HandleFunc("POST /v1/access/identities/ident-new-456/tokens", func(w http.ResponseWriter, r *http.Request) {
		callOrder = append(callOrder, "create_token")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(CreatedToken{
			ID:    "token-ssh-001",
			Token: "ssh-access-token-value",
		})
	})

	server := httptest.NewServer(mux)
	defer server.Close()

	client := NewClient(server.URL, "test-key")
	ctx := context.Background()

	// Create identity
	identity, err := client.CreateIdentity(ctx)
	require.NoError(t, err)
	assert.Equal(t, "ident-new-456", identity.ID)
	assert.True(t, identity.Managed)

	// Grant VM permission
	perm, err := client.GrantAccess(ctx, identity.ID, "vm-target-789", GrantAccessRequest{
		AllowedUsers: []string{"developer"},
	})
	require.NoError(t, err)
	assert.Equal(t, []string{"developer"}, perm.AllowedUsers)

	// Create identity token for SSH
	token, err := client.CreateIdentityToken(ctx, identity.ID)
	require.NoError(t, err)
	assert.Equal(t, "ssh-access-token-value", token.Token)

	assert.Equal(t, []string{"create_identity", "grant_permission", "create_token"}, callOrder)
}

// TestClient_ForkSandbox_MissingIDReturnsError verifies that the controller
// cannot report a successful fork without identifying the created sandbox.
func TestClient_ForkSandbox_MissingIDReturnsError(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "test-key")
	_, err := client.ForkSandbox(context.Background(), "vm-source", ForkRequest{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "did not include the created sandbox id")
}

// TestNewClient_EmptyBaseURL verifies that the controller URL must be supplied
// by configuration rather than silently targeting a vendor endpoint.
func TestNewClient_EmptyBaseURL(t *testing.T) {
	t.Parallel()

	client := NewClient("", "test-key")
	assert.Empty(t, client.baseURL)
}

// TestNewClient_TrimsTrailingSlash verifies URL normalization.
func TestNewClient_TrimsTrailingSlash(t *testing.T) {
	t.Parallel()

	client := NewClient("https://microsandbox-control.internal///", "test-key")
	assert.Equal(t, "https://microsandbox-control.internal", client.baseURL)
}

// TestNewClient_WithHTTPClient verifies the WithHTTPClient option.
func TestNewClient_WithHTTPClient(t *testing.T) {
	t.Parallel()

	custom := &http.Client{}
	client := NewClient("https://microsandbox-control.internal", "test-key", WithHTTPClient(custom))
	assert.Equal(t, custom, client.httpClient)
}

// TestNewClient_WithNilHTTPClient verifies nil is ignored.
func TestNewClient_WithNilHTTPClient(t *testing.T) {
	t.Parallel()

	client := NewClient("https://microsandbox-control.internal", "test-key", WithHTTPClient(nil))
	assert.NotNil(t, client.httpClient)
}
