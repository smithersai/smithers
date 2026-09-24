package smitherscli

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	incur "github.com/smithersai/incur"
	"golang.org/x/term"
)

func commandsWorkspaceZServe(t *testing.T, argv ...string) string {
	t.Helper()
	var stdout bytes.Buffer
	if err := workspaceCommand().ServeWithOptions(argv, incur.ServeOptions{Stdout: &stdout}); err != nil {
		t.Fatalf("workspace %v returned error: %v\n%s", argv, err, stdout.String())
	}
	return stdout.String()
}

func commandsWorkspaceZServeErr(t *testing.T, want string, argv ...string) {
	t.Helper()
	var stdout bytes.Buffer
	err := workspaceCommand().ServeWithOptions(argv, incur.ServeOptions{Stdout: &stdout})
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("workspace %v error = %v, want contains %q\n%s", argv, err, want, stdout.String())
	}
}

func commandsWorkspaceZServer(t *testing.T, sshCommand string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/repos/alice/error/workspaces":
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"message":"workspace failed"}`)
		case r.URL.Path == "/api/repos/alice/wserr/issues/11":
			fmt.Fprint(w, `{"number":11,"title":"Issue","body":""}`)
		case r.URL.Path == "/api/repos/alice/wserr/workspaces":
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"message":"workspace create failed"}`)
		case r.URL.Path == "/api/repos/alice/demo/workspaces/ws-error":
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"message":"view failed"}`)
		case r.Method == http.MethodDelete && r.URL.Path == "/api/repos/alice/demo/workspaces/ws-delete-error":
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"message":"delete failed"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/createerr/workspaces":
			fmt.Fprint(w, `[]`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/createerr/workspaces":
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"message":"create failed"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/workspaces":
			fmt.Fprint(w, `[{"id":"ws-running","status":"running"}]`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/workspaces":
			fmt.Fprint(w, `{"id":"ws-created"}`)
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/ssh"):
			if strings.Contains(r.URL.Path, "ws-forbidden") {
				w.WriteHeader(http.StatusForbidden)
				fmt.Fprint(w, `{"message":"ssh forbidden"}`)
				return
			}
			fmt.Fprintf(w, `{"command":%q}`, sshCommand)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/workspace/sessions":
			if r.URL.Query().Get("unused") == "never" {
				t.Fatal("unreachable")
			}
			fmt.Fprint(w, `{}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/workspaces/ws-watch-noname":
			fmt.Fprint(w, `{"id":"ws-watch-noname","status":"running"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/workspaces/ws-watch-noname/stream":
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "event: status\ndata: {\"status\":\"error\"}\n")
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/workspaces/ws-watch-error":
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"message":"watch failed"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/workspaces/ws-watch-stream-error":
			fmt.Fprint(w, `{"id":"ws-watch-stream-error","name":"stream","status":"running"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/workspaces/ws-watch-stream-error/stream":
			w.WriteHeader(http.StatusBadGateway)
			fmt.Fprint(w, `stream failed`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/issues/10":
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"message":"issue failed"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/issues/11":
			fmt.Fprint(w, `{"number":11,"title":"Issue","body":""}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/landings":
			fmt.Fprint(w, `{"number":99}`)
		default:
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprintf(w, `{"message":"missing %s %s"}`, r.Method, r.URL.Path)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

type commandsWorkspaceZErrReader struct{}

func (commandsWorkspaceZErrReader) Read([]byte) (int, error) {
	return 0, fmt.Errorf("stdin failed")
}

func commandsWorkspaceZWithBlockingStdin(t *testing.T, fn func()) {
	t.Helper()
	stdinReader, stdinWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	oldStdin := os.Stdin
	os.Stdin = stdinReader
	defer func() {
		os.Stdin = oldStdin
		_ = stdinWriter.Close()
		_ = stdinReader.Close()
	}()
	fn()
}

func TestCommandsWorkspace_Z_CommandErrorBranches(t *testing.T) {
	sshCommand := commandsWorkspaceHInstallFakeSSH(t)
	server := commandsWorkspaceZServer(t, sshCommand)
	commandsWorkspaceHSetAuthConfig(t, server.URL)
	t.Setenv("SMITHERS_WORKSPACE_SSH_POLL_INTERVAL_MS", "1")
	t.Setenv("SMITHERS_WORKSPACE_SSH_POLL_TIMEOUT_MS", "5")

	commandsWorkspaceZServeErr(t, "Invalid repo format", "create", "--repo", "bad")
	commandsWorkspaceZServeErr(t, "workspace failed", "create", "--repo", "alice/error")
	commandsWorkspaceZServeErr(t, "view failed", "view", "ws-error", "--repo", "alice/demo")
	commandsWorkspaceZServeErr(t, "delete failed", "delete", "ws-delete-error", "--repo", "alice/demo")
	commandsWorkspaceZServeErr(t, "Invalid repo format", "ssh", "--repo", "bad")
	commandsWorkspaceZServeErr(t, "ssh forbidden", "ssh", "ws-forbidden", "--repo", "alice/demo")
	t.Setenv("COMMANDS_WORKSPACE_H_SSH_EXIT", "9")
	commandsWorkspaceZServeErr(t, "SSH exited with code 9", "ssh", "ws-running", "--repo", "alice/demo")
	t.Setenv("COMMANDS_WORKSPACE_H_SSH_EXIT", "")
	commandsWorkspaceZServeErr(t, "watch failed", "watch", "ws-watch-error", "--repo", "alice/demo")
	commandsWorkspaceZServeErr(t, "Failed to connect", "watch", "ws-watch-stream-error", "--repo", "alice/demo")
	commandsWorkspaceZServe(t, "watch", "ws-watch-noname", "--repo", "alice/demo")
	commandsWorkspaceZServeErr(t, "Invalid repo format", "shell", "ws", "--repo", "bad")
	commandsWorkspaceZServeErr(t, "missing", "shell", "ws", "--repo", "alice/error")
	commandsWorkspaceZServeErr(t, "did not include id", "shell", "ws", "--repo", "alice/demo")
	commandsWorkspaceZServeErr(t, "Invalid repo format", "exec", "ws", "--repo", "bad", "--command", "x")
	commandsWorkspaceZServeErr(t, "--command is required", "exec", "ws", "--repo", "alice/demo", "--command", " ")
	commandsWorkspaceZServeErr(t, "ssh forbidden", "exec", "ws-forbidden", "--repo", "alice/demo", "--command", "x")
	commandsWorkspaceZServeErr(t, "create failed", "exec", "--repo", "alice/createerr", "--command", "x")
	commandsWorkspaceZServeErr(t, "unknown --seed-agent-auth", "exec", "ws-running", "--repo", "alice/demo", "--command", "stream-ok", "--seedAgentAuth", "unknown")
	commandsWorkspaceZServeErr(t, "workspace exec timed out", "exec", "ws-running", "--repo", "alice/demo", "--command", "stream-sleep", "--timeout", "1")
	commandsWorkspaceZServeErr(t, "invalid issue number", "issue", "0", "--repo", "alice/demo")
	commandsWorkspaceZServeErr(t, "issue failed", "issue", "10", "--repo", "alice/demo")
	commandsWorkspaceZServeErr(t, "workspace create failed", "issue", "11", "--repo", "alice/wserr")

	oldWait := waitForWorkspaceSSHInfoForCommand
	t.Cleanup(func() { waitForWorkspaceSSHInfoForCommand = oldWait })
	waitForWorkspaceSSHInfoForCommand = func(string, string, string) (map[string]any, error) {
		return map[string]any{"host": "only"}, nil
	}
	commandsWorkspaceZServe(t, "ssh", "ws-no-command", "--repo", "alice/demo")
	commandsWorkspaceZServeErr(t, "did not return an SSH command", "exec", "ws-no-command", "--repo", "alice/demo", "--command", "x")
	commandsWorkspaceZServeErr(t, "did not return an SSH command", "issue", "11", "--repo", "alice/demo")
	waitForWorkspaceSSHInfoForCommand = oldWait

	oldTerminal := runWorkspaceTerminalForCommand
	t.Cleanup(func() { runWorkspaceTerminalForCommand = oldTerminal })
	runWorkspaceTerminalForCommand = func(string, string, string, int, int) error {
		return fmt.Errorf("terminal failed")
	}
	sessionServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/workspace/sessions":
			fmt.Fprint(w, `{"id":"sess-z"}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/workspace/sessions/sess-z/destroy":
			fmt.Fprint(w, `{}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/workspaces":
			fmt.Fprint(w, `[{"id":"ws","status":"running"}]`)
		default:
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"missing"}`)
		}
	}))
	defer sessionServer.Close()
	commandsWorkspaceHSetAuthConfig(t, sessionServer.URL)
	commandsWorkspaceZServeErr(t, "terminal failed", "shell", "ws", "--repo", "alice/demo")
	runWorkspaceTerminalForCommand = oldTerminal
}

func TestCommandsWorkspace_Z_StreamTerminalAndHelperBranches(t *testing.T) {
	sshCommand := commandsWorkspaceHInstallFakeSSH(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/repos/alice/demo/workspaces/ws-stream/stream":
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "id: 9\ndata: {\"status\":\"running\"}\n\n")
			fmt.Fprint(w, "data: raw text\n\n")
			fmt.Fprint(w, "data: {\"status\":\"error\"}\n")
		case "/api/repos/alice/demo/workspaces/ws-empty/stream":
			w.Header().Set("Content-Type", "text/event-stream")
		case "/api/repos/alice/demo/workspace/sessions/sess/terminal":
			conn, err := websocket.Accept(w, r, nil)
			if err != nil {
				t.Errorf("accept: %v", err)
				return
			}
			defer conn.Close(websocket.StatusNormalClosure, "")
			_, _, _ = conn.Read(context.Background())
			_ = conn.Write(context.Background(), websocket.MessageBinary, []byte("binary-out"))
			_ = conn.Write(context.Background(), websocket.MessageText, []byte("plain text"))
			_ = conn.Write(context.Background(), websocket.MessageText, []byte(`{"type":"status","status":"failed"}`))
		default:
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"missing"}`)
		}
	}))
	defer server.Close()
	commandsWorkspaceHSetAuthConfig(t, server.URL)

	events, err := streamWorkspaceEvents("alice", "demo", "ws-stream")
	if err != nil || len(events) != 3 || events[0]["id"] != "9" {
		t.Fatalf("streamWorkspaceEvents = (%#v, %v)", events, err)
	}
	events, err = streamWorkspaceEvents("alice", "demo", "ws-empty")
	if err != nil || len(events) != 0 {
		t.Fatalf("streamWorkspaceEvents empty = (%#v, %v)", events, err)
	}
	t.Setenv("SMITHERS_TOKEN", "")
	if _, err := streamWorkspaceEvents("alice", "demo", "ws-stream"); err == nil {
		t.Fatal("streamWorkspaceEvents accepted missing auth")
	}
	commandsWorkspaceHSetAuthConfig(t, "://bad-url")
	if _, err := streamWorkspaceEvents("alice", "demo", "ws-stream"); err == nil {
		t.Fatal("streamWorkspaceEvents accepted bad URL")
	}
	commandsWorkspaceHSetAuthConfig(t, "http://127.0.0.1:1")
	if _, err := streamWorkspaceEvents("alice", "demo", "ws-stream"); err == nil {
		t.Fatal("streamWorkspaceEvents accepted transport error")
	}
	commandsWorkspaceHSetAuthConfig(t, server.URL)

	oldGetSize := workspaceTerminalGetSize
	t.Cleanup(func() { workspaceTerminalGetSize = oldGetSize })
	workspaceTerminalGetSize = func(int) (int, int, error) { return 81, 24, nil }
	if cols, rows := terminalSize(0, 0); cols != 81 || rows != 24 {
		t.Fatalf("terminalSize seam = %d,%d", cols, rows)
	}
	if cols, rows := terminalSize(100, 0); cols != 100 || rows != 24 {
		t.Fatalf("terminalSize partial seam = %d,%d", cols, rows)
	}
	workspaceTerminalGetSize = oldGetSize

	commandsWorkspaceHWithEmptyStdin(t, func() {
		if err := runWorkspaceTerminal("alice", "demo", "sess", 80, 24); err != nil {
			t.Fatalf("runWorkspaceTerminal binary/text = %v", err)
		}
	})
	interactive := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept interactive: %v", err)
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		_, _, _ = conn.Read(context.Background())
		_, _, _ = conn.Read(context.Background())
		_ = conn.Write(context.Background(), websocket.MessageText, []byte(`{"type":"status","status":"stopped"}`))
	}))
	defer interactive.Close()
	commandsWorkspaceHSetAuthConfig(t, interactive.URL)
	oldIsTerminal := workspaceIsTerminal
	oldMakeRaw := workspaceMakeRaw
	oldRestore := workspaceRestoreTerminal
	t.Cleanup(func() {
		workspaceIsTerminal = oldIsTerminal
		workspaceMakeRaw = oldMakeRaw
		workspaceRestoreTerminal = oldRestore
	})
	workspaceIsTerminal = func(int) bool { return true }
	workspaceMakeRaw = func(int) (*term.State, error) { return nil, nil }
	workspaceRestoreTerminal = func(int, *term.State) error { return nil }
	stdinReader, stdinWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	oldStdin := os.Stdin
	os.Stdin = stdinReader
	_, _ = stdinWriter.Write([]byte("typed"))
	interactiveStdinRestored := false
	restoreInteractiveStdin := func() {
		if interactiveStdinRestored {
			return
		}
		interactiveStdinRestored = true
		os.Stdin = oldStdin
		_ = stdinReader.Close()
		_ = stdinWriter.Close()
	}
	defer restoreInteractiveStdin()
	if err := runWorkspaceTerminal("alice", "demo", "sess", 80, 24); err != nil {
		t.Fatalf("runWorkspaceTerminal interactive = %v", err)
	}
	restoreInteractiveStdin()
	workspaceIsTerminal = oldIsTerminal
	workspaceMakeRaw = oldMakeRaw
	workspaceRestoreTerminal = oldRestore

	statusText := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept status/text: %v", err)
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		_, _, _ = conn.Read(context.Background())
		_ = conn.Write(context.Background(), websocket.MessageText, []byte(`{"type":"status","status":"running"}`))
		_ = conn.Write(context.Background(), websocket.MessageText, []byte("text-out"))
		_ = conn.Write(context.Background(), websocket.MessageText, []byte(`{"type":"status","status":"stopped"}`))
	}))
	defer statusText.Close()
	commandsWorkspaceHSetAuthConfig(t, statusText.URL)
	commandsWorkspaceZWithBlockingStdin(t, func() {
		if err := runWorkspaceTerminal("alice", "demo", "sess", 80, 24); err != nil {
			t.Fatalf("runWorkspaceTerminal status/text = %v", err)
		}
	})

	binaryOnly := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept binary: %v", err)
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		_, _, _ = conn.Read(context.Background())
		_ = conn.Write(context.Background(), websocket.MessageBinary, []byte("binary-out"))
		_ = conn.Write(context.Background(), websocket.MessageText, []byte(`{"type":"status","status":"stopped"}`))
	}))
	defer binaryOnly.Close()
	commandsWorkspaceHSetAuthConfig(t, binaryOnly.URL)
	commandsWorkspaceZWithBlockingStdin(t, func() {
		if err := runWorkspaceTerminal("alice", "demo", "sess", 80, 24); err != nil {
			t.Fatalf("runWorkspaceTerminal binary deterministic = %v", err)
		}
	})

	readClose := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept close: %v", err)
			return
		}
		_, _, _ = conn.Read(context.Background())
		_ = conn.Close(websocket.StatusInternalError, "closed")
	}))
	defer readClose.Close()
	commandsWorkspaceHSetAuthConfig(t, readClose.URL)
	commandsWorkspaceZWithBlockingStdin(t, func() {
		if err := runWorkspaceTerminal("alice", "demo", "sess", 80, 24); err != nil {
			t.Fatalf("runWorkspaceTerminal read close = %v", err)
		}
	})

	readErrServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept read err: %v", err)
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		_, _, _ = conn.Read(context.Background())
		time.Sleep(50 * time.Millisecond)
	}))
	defer readErrServer.Close()
	commandsWorkspaceHSetAuthConfig(t, readErrServer.URL)
	oldInput := workspaceTerminalInput
	t.Cleanup(func() { workspaceTerminalInput = oldInput })
	workspaceTerminalInput = func() io.Reader { return commandsWorkspaceZErrReader{} }
	if err := runWorkspaceTerminal("alice", "demo", "sess", 80, 24); err == nil || !strings.Contains(err.Error(), "stdin failed") {
		t.Fatalf("runWorkspaceTerminal stdin error = %v", err)
	}
	workspaceTerminalInput = oldInput

	writeErrServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept write err: %v", err)
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		_, _, _ = conn.Read(context.Background())
		time.Sleep(50 * time.Millisecond)
	}))
	defer writeErrServer.Close()
	commandsWorkspaceHSetAuthConfig(t, writeErrServer.URL)
	oldWrite := workspaceTerminalWrite
	t.Cleanup(func() { workspaceTerminalWrite = oldWrite })
	workspaceTerminalInput = func() io.Reader { return strings.NewReader("typed") }
	workspaceTerminalWrite = func(ctx context.Context, conn *websocket.Conn, messageType websocket.MessageType, data []byte) error {
		if messageType == websocket.MessageBinary {
			return fmt.Errorf("write failed")
		}
		return conn.Write(ctx, messageType, data)
	}
	if err := runWorkspaceTerminal("alice", "demo", "sess", 80, 24); err == nil || !strings.Contains(err.Error(), "write failed") {
		t.Fatalf("runWorkspaceTerminal write error = %v", err)
	}
	workspaceTerminalInput = oldInput
	workspaceTerminalWrite = oldWrite

	t.Setenv("SMITHERS_TOKEN", "")
	if err := runWorkspaceTerminal("alice", "demo", "sess", 80, 24); err == nil {
		t.Fatal("runWorkspaceTerminal accepted missing auth")
	}
	commandsWorkspaceHSetAuthConfig(t, "http://127.0.0.1:1")
	if err := runWorkspaceTerminal("alice", "demo", "sess", 80, 24); err == nil {
		t.Fatal("runWorkspaceTerminal accepted dial failure")
	}

	t.Setenv("SMITHERS_WORKSPACE_SSH_CONNECT_TIMEOUT_SECONDS", "7")
	args, err := buildSSHInvocationArgs("ssh developer@example.com", true)
	if err != nil {
		t.Fatalf("buildSSHInvocationArgs ssh error = %v", err)
	}
	if !strings.Contains(strings.Join(args, " "), "ConnectTimeout=7") || args[1] != "-tt" {
		t.Fatalf("buildSSHInvocationArgs = %#v", args)
	}
	if got, err := buildSSHInvocationArgs("custom arg", false); err == nil || !strings.Contains(err.Error(), "executable must be ssh") || len(got) != 0 {
		t.Fatalf("custom ssh invocation args=%#v err=%v", got, err)
	}
	if err := runSSHCommand(""); err == nil || !strings.Contains(err.Error(), "empty") {
		t.Fatalf("runSSHCommand empty = %v", err)
	}
	t.Setenv("COMMANDS_WORKSPACE_H_SSH_EXIT", "7")
	if err := runSSHCommand(sshCommand); err == nil || !strings.Contains(err.Error(), "SSH exited with code 7") {
		t.Fatalf("runSSHCommand exit = %v", err)
	}
	t.Setenv("COMMANDS_WORKSPACE_H_SSH_EXIT", "")
	if err := runSSHCommand("missing-ssh-command"); err == nil {
		t.Fatal("runSSHCommand accepted missing executable")
	}
	if err := runSSHCommand(sshCommand); err != nil {
		t.Fatalf("runSSHCommand success = %v", err)
	}
}

func TestCommandsWorkspace_Z_AuthAndRemoteCommandBranches(t *testing.T) {
	sshCommand := commandsWorkspaceHInstallFakeSSH(t)
	t.Setenv("SMITHERS_WORKSPACE_REMOTE_COMMAND_TIMEOUT_MS", "5000")
	t.Setenv("SMITHERS_WORKSPACE_CLAUDE_TIMEOUT_MS", "5000")
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "")
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("OPENAI_API_KEY", "")
	setTestClaudeKeychainPayload(t, "")
	setTestCodexAuthJSON(t, "")
	t.Setenv("HOME", t.TempDir())
	setTestCredentialStoreFile(t, filepath.Join(t.TempDir(), "creds.json"))
	if err := StoreToken(claudeSetupTokenStorageKey, "stored-claude"); err != nil {
		t.Fatal(err)
	}
	if env := getClaudeAuthEnv(); env["ANTHROPIC_AUTH_TOKEN"] != "stored-claude" {
		t.Fatalf("getClaudeAuthEnv stored = %#v", env)
	}
	DeleteStoredToken(claudeSetupTokenStorageKey)

	future := time.Now().Add(time.Hour).UnixMilli()
	setTestClaudeKeychainPayload(t, fmt.Sprintf(`{"claudeAiOauth":{"accessToken":"oauth-token","expiresAt":%d}}`, future))
	if env := getClaudeAuthEnv(); env["ANTHROPIC_AUTH_TOKEN"] != "oauth-token" {
		t.Fatalf("getClaudeAuthEnv keychain payload = %#v", env)
	}
	setTestClaudeKeychainPayload(t, "")
	oldGOOS := workspaceRuntimeGOOS
	t.Cleanup(func() { workspaceRuntimeGOOS = oldGOOS })
	workspaceRuntimeGOOS = "linux"
	if got := loadClaudeOAuthAccessTokenFromKeychain(); got != "" {
		t.Fatalf("non-darwin keychain token = %q", got)
	}
	workspaceRuntimeGOOS = oldGOOS

	if runtime.GOOS == "darwin" {
		binDir := t.TempDir()
		security := filepath.Join(binDir, "security")
		if err := os.WriteFile(security, []byte("#!/bin/sh\ncase \"${SECURITY_MODE:-ok}\" in\nempty) exit 0 ;;\nbad) printf 'not-json\\n'; exit 0 ;;\nerr) exit 4 ;;\n*) printf '{\"claudeAiOauth\":{\"accessToken\":\"security-token\"}}\\n'; exit 0 ;;\nesac\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
		t.Setenv("SECURITY_MODE", "empty")
		if got := loadClaudeOAuthAccessTokenFromKeychain(); got != "" {
			t.Fatalf("security empty token = %q", got)
		}
		t.Setenv("SECURITY_MODE", "bad")
		if got := loadClaudeOAuthAccessTokenFromKeychain(); got != "" {
			t.Fatalf("security bad token = %q", got)
		}
		t.Setenv("SECURITY_MODE", "err")
		if got := loadClaudeOAuthAccessTokenFromKeychain(); got != "" {
			t.Fatalf("security err token = %q", got)
		}
		t.Setenv("SECURITY_MODE", "ok")
		if got := loadClaudeOAuthAccessTokenFromKeychain(); got != "security-token" {
			t.Fatalf("security ok token = %q", got)
		}
	}

	oldMarshal := workspaceJSONMarshal
	t.Cleanup(func() { workspaceJSONMarshal = oldMarshal })
	workspaceJSONMarshal = func(any) ([]byte, error) { return nil, fmt.Errorf("marshal failed") }
	t.Setenv("OPENAI_API_KEY", "openai")
	if content, ok := getCodexAuthContent(); ok || content != "" {
		t.Fatalf("getCodexAuthContent marshal failure = %q %t", content, ok)
	}
	workspaceJSONMarshal = oldMarshal
	t.Setenv("OPENAI_API_KEY", "")
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, ".codex"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".codex", "auth.json"), []byte(" codex-file \n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	if got := readLocalCodexAuthFile(); got != "codex-file" {
		t.Fatalf("readLocalCodexAuthFile = %q", got)
	}
	oldHomeDir := workspaceUserHomeDir
	t.Cleanup(func() { workspaceUserHomeDir = oldHomeDir })
	workspaceUserHomeDir = func() (string, error) { return "", fmt.Errorf("home failed") }
	if got := readLocalCodexAuthFile(); got != "" {
		t.Fatalf("readLocalCodexAuthFile home error = %q", got)
	}
	workspaceUserHomeDir = oldHomeDir

	t.Setenv("ANTHROPIC_AUTH_TOKEN", "claude-token")
	if err := seedWorkspaceAgentAuth("missing-ssh-command", []string{"claude"}); err == nil {
		t.Fatal("seedWorkspaceAgentAuth claude accepted missing ssh")
	}
	setTestCodexAuthJSON(t, `{"ok":true}`)
	if err := seedWorkspaceAgentAuth("missing-ssh-command", []string{"codex"}); err == nil {
		t.Fatal("seedWorkspaceAgentAuth codex accepted missing ssh")
	}

	emptyDiagBin := t.TempDir()
	if err := os.WriteFile(filepath.Join(emptyDiagBin, "ssh"), []byte("#!/bin/sh\nstdin=$(cat)\nbegin=$(printf '%s' \"$stdin\" | grep -o '__SMITHERS_BEGIN_[A-Za-z0-9_]*__' | head -n 1)\nend=$(printf '%s' \"$stdin\" | grep -o '__SMITHERS_END_[A-Za-z0-9_]*__' | head -n 1)\nif [ -z \"$begin\" ]; then exit 0; fi\nif printf '%s' \"$stdin\" | grep -q 'claude_processes'; then printf '%s\\n\\n%s:0\\n' \"$begin\" \"$end\"; exit 0; fi\nprintf '%s\\nclaude failed\\n\\n%s:3\\n' \"$begin\" \"$end\"\nexit 3\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", emptyDiagBin+string(os.PathListSeparator)+os.Getenv("PATH"))
	if err := runWorkspaceClaudeCommand("ssh example.com", "prompt"); err == nil || !strings.Contains(err.Error(), "claude failed") {
		t.Fatalf("runWorkspaceClaudeCommand empty diagnostics = %v", err)
	}

	if _, err := runRemoteShellCommand("", "echo hi", "empty", false, time.Second); err == nil || !strings.Contains(err.Error(), "empty") {
		t.Fatalf("runRemoteShellCommand empty ssh = %v", err)
	}
	failingSSHBin := t.TempDir()
	if err := os.WriteFile(filepath.Join(failingSSHBin, "ssh"), []byte("#!/bin/sh\nexit 2\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", failingSSHBin+string(os.PathListSeparator)+os.Getenv("PATH"))
	failingSSHCommand := "ssh example.com"
	if _, err := runRemoteShellCommand(failingSSHCommand, "echo hi", "false label", false, 30*time.Second); err == nil || !strings.Contains(err.Error(), "false label exited with code") {
		t.Fatalf("runRemoteShellCommand label fallback = %v", err)
	}
	if _, ok := workspaceExitErrorCode(fmt.Errorf("plain error")); ok {
		t.Fatal("workspaceExitErrorCode classified plain error")
	}
	oldExitErrorCode := workspaceExitErrorCode
	t.Cleanup(func() { workspaceExitErrorCode = oldExitErrorCode })
	workspaceExitErrorCode = func(error) (int, bool) {
		return 0, false
	}
	if _, err := runRemoteShellCommand(failingSSHCommand, "echo hi", "false label", false, 30*time.Second); err == nil {
		t.Fatal("runRemoteShellCommand accepted non-exit classified error")
	}
	if _, err := runRemoteStreamedCommand(failingSSHCommand, "ignored", time.Second); err == nil {
		t.Fatal("runRemoteStreamedCommand accepted non-exit classified error")
	}
	workspaceExitErrorCode = oldExitErrorCode
	if _, err := runRemoteShellCommand(sshCommand, "timeout-sleep", "instant", false, 0); err == nil || !strings.Contains(err.Error(), "timed out after 1s") {
		t.Fatalf("runRemoteShellCommand zero timeout = %v", err)
	}
	if _, err := runRemoteStreamedCommand("", "echo hi", time.Second); err == nil || !strings.Contains(err.Error(), "empty") {
		t.Fatalf("runRemoteStreamedCommand empty ssh = %v", err)
	}
	if _, err := runRemoteStreamedCommand("missing-ssh-command", "echo hi", time.Second); err == nil {
		t.Fatal("runRemoteStreamedCommand accepted missing executable")
	}
	if code, err := runRemoteStreamedCommand(failingSSHCommand, "ignored", time.Second); err != nil || code == 0 {
		t.Fatalf("runRemoteStreamedCommand exit code = %d %v", code, err)
	}
	if _, err := runRemoteStreamedCommand(sshCommand, "stream-sleep", 0); err == nil || !strings.Contains(err.Error(), "timed out after 1s") {
		t.Fatalf("runRemoteStreamedCommand zero timeout = %v", err)
	}

	sshCommand = commandsWorkspaceHInstallFakeSSH(t)
	issueServer := commandsWorkspaceZServer(t, sshCommand)
	commandsWorkspaceHSetAuthConfig(t, issueServer.URL)
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "")
	t.Setenv("ANTHROPIC_API_KEY", "")
	setTestClaudeKeychainPayload(t, "not-json")
	t.Setenv("COMMANDS_WORKSPACE_H_AUTH_READY", "0")
	if _, err := runWorkspaceIssue(&incur.CommandContext{Args: map[string]any{"number": "11"}, Options: map[string]any{"repo": "alice/demo"}}); err == nil || !strings.Contains(err.Error(), "Claude Code auth is not configured") {
		t.Fatalf("runWorkspaceIssue auth error = %v", err)
	}
	t.Setenv("COMMANDS_WORKSPACE_H_AUTH_READY", "1")
	t.Setenv("COMMANDS_WORKSPACE_H_CLAUDE_FAIL", "1")
	if _, err := runWorkspaceIssue(&incur.CommandContext{Args: map[string]any{"number": "11"}, Options: map[string]any{"repo": "alice/demo"}}); err == nil || !strings.Contains(err.Error(), "Workspace diagnostics") {
		t.Fatalf("runWorkspaceIssue claude error = %v", err)
	}
	t.Setenv("COMMANDS_WORKSPACE_H_CLAUDE_FAIL", "")
	t.Setenv("COMMANDS_WORKSPACE_H_JJ_LOG_FAIL", "1")
	if _, err := runWorkspaceIssue(&incur.CommandContext{Args: map[string]any{"number": "11"}, Options: map[string]any{"repo": "alice/demo"}}); err == nil || !strings.Contains(err.Error(), "jj failed") {
		t.Fatalf("runWorkspaceIssue jj error = %v", err)
	}
	t.Setenv("COMMANDS_WORKSPACE_H_JJ_LOG_FAIL", "")
	oldWait := waitForWorkspaceSSHInfoForCommand
	waitForWorkspaceSSHInfoForCommand = func(string, string, string) (map[string]any, error) {
		return nil, fmt.Errorf("issue ssh failed")
	}
	if _, err := runWorkspaceIssue(&incur.CommandContext{Args: map[string]any{"number": "11"}, Options: map[string]any{"repo": "alice/demo"}}); err == nil || !strings.Contains(err.Error(), "issue ssh failed") {
		t.Fatalf("runWorkspaceIssue ssh error = %v", err)
	}
	waitForWorkspaceSSHInfoForCommand = oldWait
}
