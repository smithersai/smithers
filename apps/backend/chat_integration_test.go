package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
)

// Exercises the public API of the actual apps/backend composition and listener.
func TestOwnerChatHTTPIntegration(t *testing.T) {
	adminURL := os.Getenv("SMITHERS_PRODUCT_TEST_DATABASE_URL")
	if adminURL == "" {
		t.Skip("set SMITHERS_PRODUCT_TEST_DATABASE_URL")
	}
	node, err := exec.LookPath("node")
	require.NoError(t, err)
	node, err = filepath.EvalSymlinks(node)
	require.NoError(t, err)
	_, source, _, _ := runtime.Caller(0)
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "../.."))
	bundleDir := t.TempDir()
	bundle := filepath.Join(bundleDir, "smithers-model-host")
	build := exec.Command(node, filepath.Join(root, "apps/model-host/build.mjs"), bundle)
	build.Dir = root
	output, err := build.CombinedOutput()
	require.NoError(t, err, string(output))
	for _, family := range []string{"coding"} {
		name := "smithers-" + family + "-host"
		require.NoError(t, os.WriteFile(filepath.Join(bundleDir, name), []byte("#!/bin/sh\nexit 1\n"), 0o755))
	}
	librarian := filepath.Join(bundleDir, "smithers-librarian-host")
	librarianBuild := exec.Command(node, filepath.Join(root, "flows/librarian/build.mjs"), librarian)
	librarianBuild.Dir = root
	output, err = librarianBuild.CombinedOutput()
	require.NoError(t, err, string(output))
	require.NoError(t, os.Chmod(librarian, 0o755))
	manifest := map[string]any{"version": 1, "hosts": map[string]any{}}
	hosts := manifest["hosts"].(map[string]any)
	for _, family := range []string{"coding", "librarian"} {
		name := "smithers-" + family + "-host"
		content, readErr := os.ReadFile(filepath.Join(bundleDir, name))
		require.NoError(t, readErr)
		sum := sha256.Sum256(content)
		flows := []string{"coding/dispatch"}
		if family == "librarian" {
			flows = []string{"librarian/history", "librarian/wiki"}
		}
		hosts[family] = map[string]any{"executable": name, "sha256": hex.EncodeToString(sum[:]), "flows": flows}
	}
	manifestBytes, err := json.Marshal(manifest)
	require.NoError(t, err)
	manifestPath := filepath.Join(bundleDir, "flow-hosts.json")
	require.NoError(t, os.WriteFile(manifestPath, manifestBytes, 0o600))

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, adminURL)
	require.NoError(t, err)
	t.Cleanup(func() { _ = admin.Close(context.Background()) })
	dbName := "l3b_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	_, err = admin.Exec(ctx, `CREATE DATABASE `+dbName)
	require.NoError(t, err)
	t.Cleanup(func() { _, _ = admin.Exec(context.Background(), `DROP DATABASE IF EXISTS `+dbName+` WITH (FORCE)`) })
	databaseConfig, err := url.Parse(adminURL)
	require.NoError(t, err)
	databaseConfig.Path = "/" + dbName
	databaseURL := databaseConfig.String()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := listener.Addr().String()
	require.NoError(t, listener.Close())
	origin := "http://" + addr
	state := t.TempDir()
	for name, value := range map[string]string{
		"SMITHERS_DATABASE_URL":                  databaseURL,
		"SMITHERS_DATA_ROOT":                     state,
		"SMITHERS_BLOB_DATA_DIR":                 filepath.Join(state, "blobs"),
		"SMITHERS_AUTH_MODE":                     "selfhost",
		"SMITHERS_AUTH_BOOTSTRAP_TOKEN":          "owner-bootstrap-token",
		"SMITHERS_AUTH_SESSION_SECRET":           "owner-session-secret",
		"SMITHERS_LFS_SIGNING_SECRET":            "owner-lfs-secret",
		"SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY": "owner-model-encryption-secret",
		"SMITHERS_REPO_HOST_AUTH_TOKEN":          "owner-repo-token",
		"SMITHERS_PUSH_HOOK_CALLBACK_TOKEN":      "owner-push-token",
		"SMITHERS_SERVER_ADDR":                   addr,
		"SMITHERS_PUBLIC_URL":                    origin,
		"SMITHERS_FEATURE_FLAGS_WORKFLOWS":       "false",
		"SMITHERS_FEATURE_FLAGS_SANDBOXES":       "false",
		"SMITHERS_FLOW_HOST_MANIFEST":            manifestPath,
		"SMITHERS_MODEL_HOST_BUNDLE":             bundle,
		"SMITHERS_NODE_BINARY":                   node,
		"AI_GATEWAY_API_KEY":                     "test-gateway-key-only-for-deterministic-flow",
	} {
		t.Setenv(name, value)
	}
	serverCtx, stop := context.WithCancel(context.Background())
	defer stop()
	done := make(chan error, 1)
	go func() { done <- run(serverCtx, nil) }()
	client := &http.Client{Timeout: 30 * time.Second}
	ready := false
	// Fresh product migrations can take longer than ten seconds on a busy
	// PostgreSQL host. Bound readiness by elapsed time, not a poll count.
	for deadline := time.Now().Add(time.Minute); time.Now().Before(deadline); {
		response, getErr := client.Get(origin + "/readyz")
		if getErr == nil {
			response.Body.Close()
			if response.StatusCode == http.StatusOK {
				ready = true
				break
			}
		}
		select {
		case err = <-done:
			t.Fatalf("backend stopped before ready: %v", err)
		default:
		}
		time.Sleep(100 * time.Millisecond)
	}
	require.True(t, ready, "backend did not become ready")
	post := func(path, token string, body any) []byte {
		data, marshalErr := json.Marshal(body)
		require.NoError(t, marshalErr)
		request, requestErr := http.NewRequest(http.MethodPost, origin+path, bytes.NewReader(data))
		require.NoError(t, requestErr)
		request.Header.Set("Content-Type", "application/json")
		if token != "" {
			request.Header.Set("Authorization", "token "+token)
		}
		if path == "/api/auth/local/bootstrap" {
			request.Header.Set("X-Smithers-Bootstrap-Token", "owner-bootstrap-token")
		}
		response, sendErr := client.Do(request)
		require.NoError(t, sendErr)
		defer response.Body.Close()
		result, readErr := io.ReadAll(response.Body)
		require.NoError(t, readErr)
		wantStatus := http.StatusOK
		if path == "/api/user/repos" {
			wantStatus = http.StatusCreated
		}
		require.Equal(t, wantStatus, response.StatusCode, string(result))
		return result
	}
	post("/api/auth/local/bootstrap", "", map[string]string{"username": "l3bowner", "email": "l3b@example.test", "password": "owner password for integration"})
	var tokenResult struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.Unmarshal(post("/api/auth/local/token", "", map[string]string{"username": "l3bowner", "password": "owner password for integration", "name": "chat-integration"}), &tokenResult))
	require.NotEmpty(t, tokenResult.Token)
	{
		post("/api/user/repos", tokenResult.Token, map[string]any{
			"name": "flow-http-integration", "private": true, "auto_init": true, "default_bookmark": "main",
		})
		// Catalog reads require an existing workspace and must never provision one.
		var workspace struct {
			ID string `json:"workspaceId"`
		}
		require.NoError(t, json.Unmarshal(post("/api/workflow/provision", tokenResult.Token, map[string]any{
			"repo": "l3bowner/flow-http-integration",
		}), &workspace))
		_, err = uuid.Parse(workspace.ID)
		require.NoError(t, err)
		missing := post("/api/workflow/rpc", tokenResult.Token, map[string]any{
			"repo": "l3bowner/flow-http-integration", "workspaceId": workspace.ID, "procedure": "Plan",
			"payload": map[string]any{"flowId": "missing/flow", "input": map[string]any{}},
		})
		require.Contains(t, string(missing), `"ok":false`)
		require.Contains(t, string(missing), `No flow`)
		// Planning starts the admitted host; subsequent catalog reads only reconnect.
		catalog := post("/api/workflow/rpc", tokenResult.Token, map[string]any{
			"repo": "l3bowner/flow-http-integration", "workspaceId": workspace.ID, "procedure": "List", "payload": map[string]string{"_tag": "flows"},
		})
		require.Contains(t, string(catalog), `"flowId":"librarian/history"`)
		flowRPC := func(procedure string, payload any) map[string]any {
			result := post("/api/workflow/rpc", tokenResult.Token, map[string]any{
				"repo": "l3bowner/flow-http-integration", "workspaceId": workspace.ID, "procedure": procedure, "payload": payload,
			})
			var frame map[string]any
			require.NoError(t, json.Unmarshal(result, &frame))
			require.Equal(t, true, frame["ok"], string(result))
			return frame["payload"].(map[string]any)
		}
		plan := flowRPC("Plan", map[string]any{"flowId": "librarian/history", "input": map[string]string{"repo": "l3bowner/flow-http-integration"}})
		planID, ok := plan["planId"].(string)
		require.True(t, ok, "%v", plan)
		digest, ok := plan["digest"].(string)
		require.True(t, ok, "%v", plan)
		approval := map[string]any{"target": map[string]any{"_tag": "Plan", "planId": planID, "digest": digest, "envelope": plan["envelope"]},
			"scope": "run", "idempotencyKey": "approve:" + planID, "decision": "approve"}
		flowRPC("Approval.Submit", approval)
		run := flowRPC("Run", map[string]any{"_tag": "Plan", "planId": planID, "digest": digest,
			"envelope": plan["envelope"], "idempotencyKey": "run:" + planID})
		runID, ok := run["runId"].(string)
		require.True(t, ok, "%v", run)
		var status string
		for range 100 {
			snapshot := flowRPC("Projection.Snapshot", map[string]any{"selector": map[string]string{"_tag": "run-summary", "runId": runID}})
			rows, ok := snapshot["rows"].([]any)
			if ok && len(rows) > 0 {
				status, _ = rows[0].(map[string]any)["status"].(string)
				if status == "completed" || status == "failed" || status == "cancelled" {
					break
				}
			}
			time.Sleep(100 * time.Millisecond)
		}
		require.Equal(t, "completed", status)
	}
	key := "private-owner-model-key"
	received := make(chan string, 1)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case received <- r.Header.Get("Authorization"):
		default:
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"id\":\"chatcmpl-owner\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"owner chat reply\"},\"finish_reason\":null}]}\n\n")
		_, _ = io.WriteString(w, "data: {\"id\":\"chatcmpl-owner\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n")
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer provider.Close()
	credentialResponse := post("/api/model/credential", tokenResult.Token, map[string]string{"action": "enroll", "requestId": "owner-model-key-1", "name": "OWNER_PROVIDER", "origin": provider.URL, "value": key})
	require.Contains(t, string(credentialResponse), `"ok":true`)
	require.NotContains(t, string(credentialResponse), key)
	model := map[string]string{"protocol": "openai-chat", "modelId": "test-model", "credential": "OWNER_PROVIDER", "baseUrl": provider.URL}
	defaultBytes, err := json.Marshal(map[string]any{"model": model})
	require.NoError(t, err)
	defaultRequest, err := http.NewRequest(http.MethodPut, origin+"/api/model/default", bytes.NewReader(defaultBytes))
	require.NoError(t, err)
	defaultRequest.Header.Set("Content-Type", "application/json")
	defaultRequest.Header.Set("Authorization", "token "+tokenResult.Token)
	defaultResponse, err := client.Do(defaultRequest)
	require.NoError(t, err)
	defer defaultResponse.Body.Close()
	require.Equal(t, http.StatusOK, defaultResponse.StatusCode)
	stream := post("/api/agent/turn", tokenResult.Token, map[string]any{"runId": "owner-" + uuid.NewString(),
		"journal":      map[string]any{"version": 1, "legId": uuid.NewString(), "token": strings.Repeat("a", 48)},
		"instructions": "Answer briefly.", "messages": []any{map[string]string{"role": "user", "content": "Say hello"}}})
	require.Contains(t, string(stream), "owner chat reply")
	require.NotContains(t, string(stream), key)
	select {
	case got := <-received:
		require.Equal(t, "Bearer "+key, got)
	case <-time.After(time.Second):
		t.Fatal("provider did not receive owner key")
	}
	stop()
	select {
	case err = <-done:
		require.NoError(t, err)
	case <-time.After(10 * time.Second):
		t.Fatal(fmt.Sprintf("backend did not stop: %s", addr))
	}
}
