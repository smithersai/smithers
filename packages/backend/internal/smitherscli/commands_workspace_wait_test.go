package smitherscli

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	incur "github.com/smithersai/incur"
)

// workspaceWaitServer creates workspace ws-1 and then answers each status poll
// with the next entry of statuses, repeating the last one.
func workspaceWaitServer(t *testing.T, statuses ...string) (*httptest.Server, func() int) {
	t.Helper()
	var mu sync.Mutex
	polls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /api/repos/alice/demo/workspaces":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body["name"] != "trial" {
				t.Fatalf("create body = %#v, %v", body, err)
			}
			w.WriteHeader(http.StatusCreated)
			fmt.Fprint(w, `{"id":"ws-1","status":"pending"}`)
		case "GET /api/repos/alice/demo/workspaces/ws-1":
			mu.Lock()
			status := statuses[min(polls, len(statuses)-1)]
			polls++
			mu.Unlock()
			fmt.Fprint(w, status)
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.RequestURI())
		}
	}))
	t.Cleanup(server.Close)
	return server, func() int {
		mu.Lock()
		defer mu.Unlock()
		return polls
	}
}

func TestWorkspaceCreateWaitReturnsTheRunningWorkspace(t *testing.T) {
	server, polls := workspaceWaitServer(t,
		`{"id":"ws-1","status":"pending"}`,
		`{"id":"ws-1","status":"starting"}`,
		`{"id":"ws-1","status":"running","ssh_host":"ws-1.example"}`,
	)
	commandsLandCovSetConfig(t, server.URL)
	t.Setenv("SMITHERS_WORKSPACE_CREATE_POLL_INTERVAL_MS", "1")

	out := commandsLandCovServe(t, workspaceCommand(), []string{"create", "--repo", "alice/demo", "--name", "trial", "--wait", "--json"})
	if !strings.Contains(out, `"status": "running"`) || !strings.Contains(out, "ws-1.example") {
		t.Fatalf("create --wait output = %s", out)
	}
	if got := polls(); got != 3 {
		t.Fatalf("status polls = %d, want 3", got)
	}
}

func TestWorkspaceCreateWaitExitsWithTheFailureCode(t *testing.T) {
	server, _ := workspaceWaitServer(t,
		`{"id":"ws-1","status":"starting"}`,
		`{"id":"ws-1","status":"failed","failure_code":"image_pull_failed","failure_message":"pull docker.io/acme/missing: not found"}`,
	)
	commandsLandCovSetConfig(t, server.URL)
	t.Setenv("SMITHERS_WORKSPACE_CREATE_POLL_INTERVAL_MS", "1")

	var stdout bytes.Buffer
	err := workspaceCommand().ServeWithOptions([]string{"create", "--repo", "alice/demo", "--name", "trial", "--wait"}, incur.ServeOptions{Stdout: &stdout})
	var incurErr *incur.IncurError
	if !errors.As(err, &incurErr) {
		t.Fatalf("create --wait error = %#v, want *incur.IncurError", err)
	}
	if incurErr.Code != "WORKSPACE_IMAGE_PULL_FAILED" || incurErr.ExitCode != 1 || !strings.HasPrefix(incurErr.Message, "pull docker.io/acme/missing: not found") {
		t.Fatalf("create --wait error = %#v", incurErr)
	}
	// The failed workspace still holds quota. incur renders only the code and
	// message, so the cleanup command must be in what the user actually sees.
	if !strings.Contains(stdout.String(), "smithers workspace delete ws-1") {
		t.Fatalf("create --wait output does not say how to remove the failed workspace:\n%s", stdout.String())
	}
}

func TestWaitForWorkspaceStatusDefaultsAnUnlabelledFailure(t *testing.T) {
	server, _ := workspaceWaitServer(t, `{"id":"ws-1","status":"error"}`)
	commandsLandCovSetConfig(t, server.URL)

	ws, err := waitForWorkspaceStatus("alice", "demo", "ws-1", defaultWorkspaceCreateWaitTimeout)
	var incurErr *incur.IncurError
	if !errors.As(err, &incurErr) || incurErr.Code != "WORKSPACE_WORKSPACE_FAILED" || !strings.HasPrefix(incurErr.Message, "workspace provisioning failed; workspace ws-1 remains") {
		t.Fatalf("unlabelled failure error = %#v", err)
	}
	if ws["status"] != "error" {
		t.Fatalf("unlabelled failure workspace = %#v", ws)
	}
}

func TestWaitForWorkspaceStatusTimesOutWithTheLastStatus(t *testing.T) {
	server, polls := workspaceWaitServer(t, `{"id":"ws-1","status":"starting"}`)
	commandsLandCovSetConfig(t, server.URL)
	t.Setenv("SMITHERS_WORKSPACE_CREATE_POLL_INTERVAL_MS", "60000")

	_, err := waitForWorkspaceStatus("alice", "demo", "ws-1", defaultWorkspaceCreateWaitInterval)
	if err == nil || !strings.Contains(err.Error(), "did not become running within 3s (status: starting)") {
		t.Fatalf("timeout error = %v", err)
	}
	if got := polls(); got != 1 {
		t.Fatalf("status polls = %d, want 1 when the next poll would pass the deadline", got)
	}
}
