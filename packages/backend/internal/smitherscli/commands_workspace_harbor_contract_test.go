package smitherscli

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// The benchmark harness (evals/harbor/plue_env.py) creates a trial workspace
// with exactly this argv and reads id and status from the JSON reply.
func TestWorkspaceCreateAcceptsTheHarborArgv(t *testing.T) {
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "POST /api/repos/alice/demo/workspaces":
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("create body: %v", err)
			}
			w.WriteHeader(http.StatusCreated)
			fmt.Fprint(w, `{"id":"ws-1","status":"pending"}`)
		case "GET /api/repos/alice/demo/workspaces/ws-1":
			fmt.Fprint(w, `{"id":"ws-1","status":"running"}`)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.RequestURI())
		}
	}))
	t.Cleanup(server.Close)
	commandsLandCovSetConfig(t, server.URL)
	t.Setenv("SMITHERS_WORKSPACE_CREATE_POLL_INTERVAL_MS", "1")

	out := commandsLandCovServe(t, workspaceCommand(), []string{
		"create", "--repo", "alice/demo", "--name", "trial-env",
		"--image", "docker.io/library/python:3.13-slim",
		"--network", "allowlist", "--idle-timeout", "0",
		"--wait", "--wait-timeout", "30", "--format", "json",
		"--cpus", "2", "--memory", "4096", "--disk", "10240",
		"--allow", "pypi.org", "--allow", "files.pythonhosted.org",
	})
	want := map[string]any{
		"name":                 "trial-env",
		"image":                "docker.io/library/python:3.13-slim",
		"resources":            map[string]any{"cpus": 2.0, "memory_mb": 4096.0, "disk_mb": 10240.0},
		"network":              map[string]any{"mode": "allowlist", "allow": []any{"pypi.org", "files.pythonhosted.org"}},
		"idle_timeout_seconds": 0.0,
	}
	if !reflect.DeepEqual(body, want) {
		t.Fatalf("create body = %#v, want %#v", body, want)
	}
	var reply map[string]any
	if err := json.Unmarshal([]byte(out[strings.Index(out, "{"):]), &reply); err != nil || reply["id"] != "ws-1" || reply["status"] != "running" {
		t.Fatalf("create reply = %s (%v)", out, err)
	}
}

// harborFakeSSH installs an ssh that runs its last argument under bash with
// HOME set to a scratch directory, as the guest's SSH exec channel does.
func harborFakeSSH(t *testing.T) string {
	t.Helper()
	bin := t.TempDir()
	home := t.TempDir()
	script := "#!/bin/sh\nfor arg in \"$@\"; do last=\"$arg\"; done\nHOME=" + home + " exec /bin/bash -c \"$last\"\n"
	if err := os.WriteFile(filepath.Join(bin, "ssh"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	return home
}

// plue_env.py and plue_docker.py run every trial command with this argv and
// read exit_code, stdout and stderr from the JSON reply; the process exit
// status mirrors the remote command's.
func TestWorkspaceExecAcceptsTheHarborArgv(t *testing.T) {
	harborFakeSSH(t)
	var sshQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /api/repos/alice/demo/workspaces/ws-1/ssh":
			sshQuery = r.URL.RawQuery
			fmt.Fprint(w, `{"command":"ssh root@ws-1.example"}`)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.RequestURI())
		}
	}))
	t.Cleanup(server.Close)
	commandsLandCovSetConfig(t, server.URL)
	cwd := t.TempDir()
	cwd, _ = filepath.EvalSymlinks(cwd)
	t.Cleanup(func() { pendingProcessExitCode = 0 })

	pendingProcessExitCode = 0
	out := commandsLandCovServe(t, workspaceCommand(), []string{
		"exec", "ws-1", "--repo", "alice/demo", "--user", "root",
		"--timeout", "0", "--format", "json", "--exec-id", "shim-0123456789abcdef",
		"--cwd", cwd, "--env", "FOO=bar baz", "--env", "EMPTY=",
		"--command", "pwd; printf '%s|%s\\n' \"$FOO\" \"$EMPTY\"; printf 'oops\\n' >&2; exit 3",
	})
	if sshQuery != "user=root" {
		t.Fatalf("ssh info query = %q, want user=root", sshQuery)
	}
	var reply map[string]any
	if err := json.Unmarshal([]byte(out[strings.Index(out, "{"):]), &reply); err != nil {
		t.Fatalf("exec reply = %s (%v)", out, err)
	}
	want := map[string]any{"workspace_id": "ws-1", "exit_code": 3.0, "stdout": cwd + "\nbar baz|\n", "stderr": "oops\n"}
	if !reflect.DeepEqual(reply, want) {
		t.Fatalf("exec reply = %#v, want %#v", reply, want)
	}
	if pendingProcessExitCode != 3 {
		t.Fatalf("process exit code = %d, want 3", pendingProcessExitCode)
	}
}

// With stdin attached (plue_docker.py forwards a piped stdin and omits
// --exec-id), the command streams over one SSH session and reads it.
func TestWorkspaceExecForwardsPipedStdin(t *testing.T) {
	harborFakeSSH(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"command":"ssh root@ws-1.example"}`)
	}))
	t.Cleanup(server.Close)
	commandsLandCovSetConfig(t, server.URL)
	path := filepath.Join(t.TempDir(), "stdin")
	if err := os.WriteFile(path, []byte("from stdin\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stdin
	os.Stdin = file
	t.Cleanup(func() { os.Stdin = old; _ = file.Close(); pendingProcessExitCode = 0 })

	out := commandsLandCovServe(t, workspaceCommand(), []string{
		"exec", "ws-1", "--repo", "alice/demo", "--user", "root", "--timeout", "0", "--format", "json",
		"--command", "tr a-z A-Z",
	})
	if !strings.Contains(out, `"stdout": "FROM STDIN\n"`) || !strings.Contains(out, `"exit_code": 0`) {
		t.Fatalf("exec with stdin = %s", out)
	}
}
