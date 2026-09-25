package smitherscli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	incur "github.com/smithersai/incur"
)

func authZServe(t *testing.T, cli *incur.Cli, argv ...string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	err := cli.ServeWithOptions(argv, incur.ServeOptions{Stdout: &out, Stderr: &out})
	return out.String(), err
}

func authZSetStdin(t *testing.T, input string) {
	t.Helper()
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writer.WriteString(input); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	old := os.Stdin
	os.Stdin = reader
	t.Cleanup(func() {
		os.Stdin = old
		_ = reader.Close()
	})
}

func authZSetClosedStdin(t *testing.T) {
	t.Helper()
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	_ = writer.Close()
	_ = reader.Close()
	old := os.Stdin
	os.Stdin = reader
	t.Cleanup(func() {
		os.Stdin = old
	})
}

func authZWithResolver(t *testing.T, resolver func(map[string]string) (AuthTarget, error)) {
	t.Helper()
	old := authTargetResolver
	authTargetResolver = resolver
	t.Cleanup(func() { authTargetResolver = old })
}

func authZWithListen(t *testing.T, listen func(string, string) (net.Listener, error)) {
	t.Helper()
	old := authListen
	authListen = listen
	t.Cleanup(func() { authListen = old })
}

func authZWithOpenBrowser(t *testing.T, opener func(string) error) {
	t.Helper()
	old := authOpenBrowser
	authOpenBrowser = opener
	t.Cleanup(func() { authOpenBrowser = old })
}

func authZWithRuntimeGOOS(t *testing.T, goos string) {
	t.Helper()
	old := authRuntimeGOOS
	authRuntimeGOOS = goos
	t.Cleanup(func() { authRuntimeGOOS = old })
}

func authZClearClaudeEnv(t *testing.T) {
	t.Helper()
	t.Setenv("ANTHROPIC_AUTH_TOKEN", "")
	t.Setenv("ANTHROPIC_API_KEY", "")
}

func authZClearSmithersEnv(t *testing.T) {
	t.Helper()
	t.Setenv("SMITHERS_TOKEN", "")
}

func authZLoginServer(t *testing.T, username string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/github/cli":
			port := r.URL.Query().Get("callback_port")
			if port == "" {
				t.Fatal("callback_port was empty")
			}
			fragment := "token=smithers_browser_z&email=z%40example.test&expires_at=tomorrow&callback_state=" + r.URL.Query().Get("callback_state")
			if username != "" {
				fragment += "&username=" + url.QueryEscape(username)
			}
			http.Redirect(w, r, "http://127.0.0.1:"+port+"/callback#"+fragment, http.StatusFound)
		case "/api/user":
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"login":"zuser","email":"z@example.test"}`)
		default:
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{}`)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func authZSecretServer(t *testing.T, status int) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/user" {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"login":"zuser"}`)
			return
		}
		if r.URL.Path != "/api/repos/alice/demo/secrets" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		if status >= 400 {
			w.WriteHeader(status)
			fmt.Fprint(w, `{"message":"forced"}`)
			return
		}
		fmt.Fprint(w, `{"ok":true}`)
	}))
	t.Cleanup(server.Close)
	return server
}

func authZClosedHTTPURL(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return "http://" + addr
}

func authZCallbackURL(t *testing.T, loginURL string) string {
	t.Helper()
	parsed, err := url.Parse(loginURL)
	if err != nil {
		t.Fatal(err)
	}
	port := parsed.Query().Get("callback_port")
	if port == "" {
		t.Fatal("callback_port was empty")
	}
	return "http://127.0.0.1:" + port + "/callback"
}

func authZPostJSON(t *testing.T, target string, payload any) *http.Response {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.Post(target, "application/json", bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func TestCommandsAuth_Z_LoginWithTokenBranches(t *testing.T) {
	t.Run("explicit success", func(t *testing.T) {
		commandsAuthCovSetConfig(t, "https://api.example.test")
		authZSetStdin(t, "smithers_with_token_z\n")
		if _, err := authZServe(t, authCommand(), "login", "--with-token", "--json"); err != nil {
			t.Fatalf("login --with-token --json = %v", err)
		}
	})

	t.Run("plain success", func(t *testing.T) {
		commandsAuthCovSetConfig(t, "https://api.example.test")
		authZSetStdin(t, "smithers_plain_token_z\n")
		if _, err := authZServe(t, authCommand(), "login", "--with-token"); err != nil {
			t.Fatalf("login --with-token = %v", err)
		}
	})

	t.Run("stdin read error", func(t *testing.T) {
		commandsAuthCovSetConfig(t, "https://api.example.test")
		authZSetClosedStdin(t)
		if _, err := authZServe(t, authCommand(), "login", "--with-token"); err == nil {
			t.Fatal("expected stdin read error")
		}
	})

	t.Run("token validation error", func(t *testing.T) {
		commandsAuthCovSetConfig(t, "https://api.example.test")
		authZSetStdin(t, "not-a-token")
		if _, err := authZServe(t, authCommand(), "login", "--with-token"); err == nil || !strings.Contains(err.Error(), "Invalid token") {
			t.Fatalf("validation error = %v", err)
		}
	})

	t.Run("persist error", func(t *testing.T) {
		root := t.TempDir()
		commandsAuthCovSetConfig(t, "https://api.example.test")
		storeDir := filepath.Join(root, "store-dir")
		if err := os.MkdirAll(storeDir, 0o755); err != nil {
			t.Fatal(err)
		}
		setTestCredentialStoreFile(t, storeDir)
		authZSetStdin(t, "smithers_store_error_z")
		if _, err := authZServe(t, authCommand(), "login", "--with-token"); err == nil {
			t.Fatal("expected persist error")
		}
	})
}

func TestCommandsAuth_Z_LoginBrowserBranches(t *testing.T) {
	t.Run("explicit username success", func(t *testing.T) {
		server := authZLoginServer(t, "zelda")
		commandsAuthCovSetConfig(t, server.URL)
		setTestBrowserFetch(t, true)
		if _, err := authZServe(t, authCommand(), "login", "--json"); err != nil {
			t.Fatalf("browser login --json = %v", err)
		}
	})

	t.Run("plain no username success", func(t *testing.T) {
		server := authZLoginServer(t, "")
		commandsAuthCovSetConfig(t, server.URL)
		setTestBrowserFetch(t, true)
		if _, err := authZServe(t, authCommand(), "login"); err != nil {
			t.Fatalf("browser login = %v", err)
		}
	})

	t.Run("browser login error", func(t *testing.T) {
		commandsAuthCovSetConfig(t, "https://api.example.test")
		authZWithListen(t, func(string, string) (net.Listener, error) {
			return nil, errors.New("listen boom")
		})
		if _, err := authZServe(t, authCommand(), "login"); err == nil || !strings.Contains(err.Error(), "listen boom") {
			t.Fatalf("browser login error = %v", err)
		}
	})

	t.Run("persist after browser error", func(t *testing.T) {
		server := authZLoginServer(t, "zelda")
		root := t.TempDir()
		commandsAuthCovSetConfig(t, server.URL)
		setTestBrowserFetch(t, true)
		storeDir := filepath.Join(root, "store-dir")
		if err := os.MkdirAll(storeDir, 0o755); err != nil {
			t.Fatal(err)
		}
		setTestCredentialStoreFile(t, storeDir)
		if _, err := authZServe(t, authCommand(), "login"); err == nil {
			t.Fatal("expected browser persist error")
		}
	})
}

func TestCommandsAuth_Z_LogoutStatusTokenHandlers(t *testing.T) {
	t.Run("logout plain with env warning", func(t *testing.T) {
		commandsAuthCovSetConfig(t, "https://api.example.test")
		t.Setenv("SMITHERS_TOKEN", "smithers_env_z")
		if _, err := authZServe(t, authCommand(), "logout"); err != nil {
			t.Fatalf("logout = %v", err)
		}
	})

	t.Run("logout explicit", func(t *testing.T) {
		commandsAuthCovSetConfig(t, "https://api.example.test")
		if _, err := authZServe(t, authCommand(), "logout", "--json"); err != nil {
			t.Fatalf("logout --json = %v", err)
		}
	})

	t.Run("logout error", func(t *testing.T) {
		authZWithResolver(t, func(map[string]string) (AuthTarget, error) {
			return AuthTarget{}, errors.New("logout resolver boom")
		})
		if _, err := authZServe(t, authCommand(), "logout"); err == nil || !strings.Contains(err.Error(), "logout resolver boom") {
			t.Fatalf("logout resolver error = %v", err)
		}
	})

	t.Run("status explicit and plain", func(t *testing.T) {
		server := authZLoginServer(t, "zelda")
		commandsAuthCovSetConfig(t, server.URL)
		t.Setenv("SMITHERS_TOKEN", "smithers_status_z")
		if _, err := authZServe(t, authCommand(), "status", "--json"); err != nil {
			t.Fatalf("status --json = %v", err)
		}
		if _, err := authZServe(t, authCommand(), "status"); err != nil {
			t.Fatalf("status = %v", err)
		}
	})

	t.Run("token error explicit and plain", func(t *testing.T) {
		commandsAuthCovSetConfig(t, "https://api.example.test")
		authZClearSmithersEnv(t)
		if _, err := authZServe(t, authCommand(), "token"); err == nil {
			t.Fatal("expected missing token error")
		}
		t.Setenv("SMITHERS_TOKEN", "smithers_token_z")
		if _, err := authZServe(t, authCommand(), "token", "--json"); err != nil {
			t.Fatalf("token --json = %v", err)
		}
		if _, err := authZServe(t, authCommand(), "token"); err != nil {
			t.Fatalf("token = %v", err)
		}
	})
}

func TestCommandsAuth_Z_ClaudeLoginHandlers(t *testing.T) {
	t.Run("stdin read error", func(t *testing.T) {
		commandsAuthCovSetConfig(t, "https://api.example.test")
		authZClearClaudeEnv(t)
		authZSetClosedStdin(t)
		if _, err := authZServe(t, claudeAuthCommand(), "login"); err == nil {
			t.Fatal("expected stdin read error")
		}
	})

	t.Run("token validation error", func(t *testing.T) {
		commandsAuthCovSetConfig(t, "https://api.example.test")
		authZClearClaudeEnv(t)
		authZSetStdin(t, "not a setup token")
		if _, err := authZServe(t, claudeAuthCommand(), "login"); err == nil || !strings.Contains(err.Error(), "Invalid Claude setup token") {
			t.Fatalf("claude validation error = %v", err)
		}
	})

	t.Run("stored token message", func(t *testing.T) {
		commandsAuthCovSetConfig(t, "https://api.example.test")
		authZClearClaudeEnv(t)
		t.Setenv("PATH", t.TempDir())
		authZSetStdin(t, "sk-ant-oat1-token")
		if _, err := authZServe(t, claudeAuthCommand(), "login", "--json"); err != nil {
			t.Fatalf("claude login stored = %v", err)
		}
	})

	t.Run("store error", func(t *testing.T) {
		root := t.TempDir()
		commandsAuthCovSetConfig(t, "https://api.example.test")
		authZClearClaudeEnv(t)
		storeDir := filepath.Join(root, "store-dir")
		if err := os.MkdirAll(storeDir, 0o755); err != nil {
			t.Fatal(err)
		}
		setTestCredentialStoreFile(t, storeDir)
		authZSetStdin(t, "sk-ant-oat1-token")
		if _, err := authZServe(t, claudeAuthCommand(), "login", "--json"); err == nil {
			t.Fatal("expected claude login to surface StoreToken error")
		}
	})

	t.Run("active env remains message", func(t *testing.T) {
		commandsAuthCovSetConfig(t, "https://api.example.test")
		t.Setenv("PATH", t.TempDir())
		t.Setenv("ANTHROPIC_AUTH_TOKEN", "env-claude")
		authZSetStdin(t, "sk-ant-oat1-token")
		if _, err := authZServe(t, claudeAuthCommand(), "login", "--json"); err != nil {
			t.Fatalf("claude login env active = %v", err)
		}
	})

	t.Run("push success message", func(t *testing.T) {
		server := authZSecretServer(t, http.StatusOK)
		commandsAuthCovSetConfig(t, server.URL)
		authZClearClaudeEnv(t)
		t.Setenv("SMITHERS_TOKEN", "smithers_push_z")
		authZSetStdin(t, "sk-ant-oat1-token")
		if _, err := authZServe(t, claudeAuthCommand(), "login", "--repo", "alice/demo", "--json"); err != nil {
			t.Fatalf("claude login push = %v", err)
		}
	})

	t.Run("detected repo without --repo is not pushed", func(t *testing.T) {
		var requests []string
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requests = append(requests, r.Method+" "+r.URL.Path)
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"ok":true}`)
		}))
		t.Cleanup(server.Close)
		commandsAuthCovSetConfig(t, server.URL)
		authZClearClaudeEnv(t)
		t.Setenv("SMITHERS_TOKEN", "smithers_push_z")
		agentFInstallJj(t)
		t.Setenv("AGENTF_REMOTES", "origin https://127.0.0.1/alice/demo.git")
		authZSetStdin(t, "sk-ant-oat1-token")
		out, err := authZServe(t, claudeAuthCommand(), "login", "--json")
		if err != nil {
			t.Fatalf("claude login without --repo = %v", err)
		}
		if len(requests) != 0 {
			t.Fatalf("claude login without --repo sent %v; the personal token must stay local", requests)
		}
		if strings.Contains(out, "pushed_secret") || strings.Contains(out, "alice/demo") {
			t.Fatalf("claude login without --repo reported a push: %s", out)
		}
		got, loadErr := LoadStoredToken(claudeSetupTokenStorageKey)
		if loadErr != nil {
			t.Fatal(loadErr)
		}
		if got = strings.TrimSpace(got); got != "sk-ant-oat1-token" {
			t.Fatalf("stored token = %q", got)
		}
	})

	t.Run("explicit push error", func(t *testing.T) {
		server := authZSecretServer(t, http.StatusInternalServerError)
		commandsAuthCovSetConfig(t, server.URL)
		authZClearClaudeEnv(t)
		t.Setenv("SMITHERS_TOKEN", "smithers_push_z")
		authZSetStdin(t, "sk-ant-oat1-token")
		if _, err := authZServe(t, claudeAuthCommand(), "login", "--repo", "alice/demo"); err == nil {
			t.Fatal("expected claude push error")
		}
	})
}

func TestCommandsAuth_Z_ClaudeOtherHandlers(t *testing.T) {
	t.Run("logout message variants", func(t *testing.T) {
		commandsAuthCovSetConfig(t, "https://api.example.test")
		authZClearClaudeEnv(t)
		if _, err := authZServe(t, claudeAuthCommand(), "logout", "--json"); err != nil {
			t.Fatalf("logout no token = %v", err)
		}
		if err := StoreToken(claudeSetupTokenStorageKey, "stored-claude"); err != nil {
			t.Fatal(err)
		}
		if _, err := authZServe(t, claudeAuthCommand(), "logout", "--json"); err != nil {
			t.Fatalf("logout stored = %v", err)
		}
		t.Setenv("ANTHROPIC_AUTH_TOKEN", "env-claude")
		if _, err := authZServe(t, claudeAuthCommand(), "logout", "--json"); err != nil {
			t.Fatalf("logout env = %v", err)
		}
		if err := StoreToken(claudeSetupTokenStorageKey, "stored-claude"); err != nil {
			t.Fatal(err)
		}
		if _, err := authZServe(t, claudeAuthCommand(), "logout", "--json"); err != nil {
			t.Fatalf("logout cleared with env = %v", err)
		}
	})

	t.Run("status variants", func(t *testing.T) {
		commandsAuthCovSetConfig(t, "https://api.example.test")
		authZClearClaudeEnv(t)
		if _, err := authZServe(t, claudeAuthCommand(), "status", "--json"); err != nil {
			t.Fatalf("status none = %v", err)
		}
		t.Setenv("ANTHROPIC_API_KEY", "api-key")
		if _, err := authZServe(t, claudeAuthCommand(), "status", "--json"); err != nil {
			t.Fatalf("status configured = %v", err)
		}
	})

	t.Run("token variants", func(t *testing.T) {
		commandsAuthCovSetConfig(t, "https://api.example.test")
		authZClearClaudeEnv(t)
		if _, err := authZServe(t, claudeAuthCommand(), "token"); err == nil {
			t.Fatal("expected missing claude token error")
		}
		t.Setenv("ANTHROPIC_AUTH_TOKEN", "env-claude")
		if _, err := authZServe(t, claudeAuthCommand(), "token", "--json"); err != nil {
			t.Fatalf("token --json = %v", err)
		}
		if _, err := authZServe(t, claudeAuthCommand(), "token"); err != nil {
			t.Fatalf("token = %v", err)
		}
	})

	t.Run("push variants", func(t *testing.T) {
		commandsAuthCovSetConfig(t, "https://api.example.test")
		authZClearClaudeEnv(t)
		if _, err := authZServe(t, claudeAuthCommand(), "push", "--repo", "alice/demo"); err == nil {
			t.Fatal("expected missing claude token push error")
		}

		server := authZSecretServer(t, http.StatusOK)
		commandsAuthCovSetConfig(t, server.URL)
		authZClearClaudeEnv(t)
		t.Setenv("SMITHERS_TOKEN", "smithers_push_z")
		t.Setenv("ANTHROPIC_AUTH_TOKEN", "env-claude")
		if _, err := authZServe(t, claudeAuthCommand(), "push", "--repo", "alice/demo", "--json"); err != nil {
			t.Fatalf("push success = %v", err)
		}

		failServer := authZSecretServer(t, http.StatusInternalServerError)
		commandsAuthCovSetConfig(t, failServer.URL)
		authZClearClaudeEnv(t)
		t.Setenv("SMITHERS_TOKEN", "smithers_push_z")
		t.Setenv("ANTHROPIC_AUTH_TOKEN", "env-claude")
		if _, err := authZServe(t, claudeAuthCommand(), "push", "--repo", "alice/demo"); err == nil {
			t.Fatal("expected push API error")
		}
	})
}

func TestCommandsAuth_Z_BrowserCandidateAndOpenBranches(t *testing.T) {
	authZWithRuntimeGOOS(t, "darwin")
	if got := browserCandidates("https://login.example"); len(got) != 1 || got[0][0] != "open" {
		t.Fatalf("darwin candidates = %#v", got)
	}

	authRuntimeGOOS = "windows"
	if got := browserCandidates("https://login.example"); len(got) != 1 || got[0][0] != "cmd.exe" {
		t.Fatalf("windows candidates = %#v", got)
	}

	authRuntimeGOOS = "linux"
	if got := browserCandidates("https://login.example"); len(got) != 2 || got[0][0] != "xdg-open" || got[1][0] != "gio" {
		t.Fatalf("linux candidates = %#v", got)
	}

	setTestBrowserFetch(t, false)
	t.Setenv("PATH", t.TempDir())
	if err := openBrowser("https://login.example"); err == nil || !strings.Contains(err.Error(), "no browser launcher") {
		t.Fatalf("no launcher error = %v", err)
	}

	binDir := t.TempDir()
	launcher := filepath.Join(binDir, "xdg-open")
	if err := os.WriteFile(launcher, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)
	if err := openBrowser("https://login.example"); err != nil {
		t.Fatalf("openBrowser launcher = %v", err)
	}

	authRuntimeGOOS = "windows"
	t.Setenv("PATH", t.TempDir())
	if err := openBrowser("https://login.example"); err == nil {
		t.Fatal("expected cmd.exe start error")
	}
}

func TestCommandsAuth_Z_FetchBrowserLoginURLErrors(t *testing.T) {
	if err := fetchBrowserLoginURL("http://%zz"); err == nil {
		t.Fatal("expected invalid URL fetch error")
	}

	t.Run("bad location", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Location", "http://[::1")
			w.WriteHeader(http.StatusOK)
		}))
		defer server.Close()
		if err := fetchBrowserLoginURL(server.URL); err == nil {
			t.Fatal("expected bad location error")
		}
	})

	t.Run("callback post error", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, authZClosedHTTPURL(t)+"/callback#token=smithers_cb", http.StatusFound)
		}))
		defer server.Close()
		if err := fetchBrowserLoginURL(server.URL); err == nil {
			t.Fatal("expected callback post error")
		}
	})

	t.Run("callback status error", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/login":
				http.Redirect(w, r, "/callback#token=smithers_cb", http.StatusFound)
			case "/callback":
				http.Error(w, "no", http.StatusInternalServerError)
			default:
				t.Fatalf("unexpected path: %s", r.URL.Path)
			}
		}))
		defer server.Close()
		if err := fetchBrowserLoginURL(server.URL + "/login"); err == nil || !strings.Contains(err.Error(), "callback failed") {
			t.Fatalf("callback status error = %v", err)
		}
	})

	t.Run("follow get error", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, authZClosedHTTPURL(t)+"/next", http.StatusFound)
		}))
		defer server.Close()
		if err := fetchBrowserLoginURL(server.URL); err == nil {
			t.Fatal("expected follow get error")
		}
	})

	t.Run("follow status error", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/login":
				http.Redirect(w, r, "/fail", http.StatusFound)
			case "/fail":
				http.Error(w, "no", http.StatusInternalServerError)
			default:
				t.Fatalf("unexpected path: %s", r.URL.Path)
			}
		}))
		defer server.Close()
		if err := fetchBrowserLoginURL(server.URL + "/login"); err == nil || !strings.Contains(err.Error(), "fetch failed") {
			t.Fatalf("follow status error = %v", err)
		}
	})
}

func TestCommandsAuth_Z_RunBrowserLoginSetupErrors(t *testing.T) {
	t.Run("resolver error", func(t *testing.T) {
		authZWithResolver(t, func(map[string]string) (AuthTarget, error) {
			return AuthTarget{}, errors.New("resolver boom")
		})
		if _, err := runBrowserLogin(nil); err == nil || !strings.Contains(err.Error(), "resolver boom") {
			t.Fatalf("resolver error = %v", err)
		}
	})

	t.Run("listener error", func(t *testing.T) {
		commandsAuthCovSetConfig(t, "https://api.example.test")
		authZWithListen(t, func(string, string) (net.Listener, error) {
			return nil, errors.New("listen boom")
		})
		if _, err := runBrowserLogin(nil); err == nil || !strings.Contains(err.Error(), "listen boom") {
			t.Fatalf("listen error = %v", err)
		}
	})

	t.Run("open browser error then timeout", func(t *testing.T) {
		commandsAuthCovSetConfig(t, "https://api.example.test")
		authZWithOpenBrowser(t, func(string) error {
			return errors.New("open boom")
		})
		oldTimeout := browserLoginTimeout
		browserLoginTimeout = 10 * time.Millisecond
		t.Cleanup(func() { browserLoginTimeout = oldTimeout })
		if _, err := runBrowserLogin(nil); err == nil || !strings.Contains(err.Error(), "Timed out") {
			t.Fatalf("timeout after opener error = %v", err)
		}
	})
}

func TestCommandsAuth_Z_RunBrowserLoginCallbackBranches(t *testing.T) {
	t.Run("guard and success", func(t *testing.T) {
		commandsAuthCovSetConfig(t, "https://api.example.test")
		allowShutdown := make(chan struct{})
		oldShutdown := authShutdownServer
		authShutdownServer = func(server *http.Server) {
			go func() {
				<-allowShutdown
				_ = server.Shutdown(context.Background())
			}()
		}
		t.Cleanup(func() {
			authShutdownServer = oldShutdown
		})
		authZWithOpenBrowser(t, func(loginURL string) error {
			callbackURL := authZCallbackURL(t, loginURL)
			resp, err := http.Get(callbackURL)
			if err != nil {
				return err
			}
			_ = resp.Body.Close()
			req, err := http.NewRequest(http.MethodPut, callbackURL, nil)
			if err != nil {
				return err
			}
			resp, err = http.DefaultClient.Do(req)
			if err != nil {
				return err
			}
			_ = resp.Body.Close()
			resp, err = http.Post(callbackURL, "text/plain", strings.NewReader("token=smithers_bad"))
			if err != nil {
				return err
			}
			_ = resp.Body.Close()
			resp = authZPostJSON(t, callbackURL, map[string]string{
				"token":          "smithers_callback_z",
				"username":       "casey",
				"email":          "casey@example.test",
				"expires_at":     "later",
				"callback_state": authZCallbackState(t, loginURL),
			})
			_ = resp.Body.Close()
			resp = authZPostJSON(t, callbackURL, map[string]string{"token": "smithers_duplicate_z"})
			_ = resp.Body.Close()
			close(allowShutdown)
			return nil
		})
		result, err := runBrowserLogin(nil)
		if err != nil {
			t.Fatalf("runBrowserLogin success = %v", err)
		}
		if result.Token != "smithers_callback_z" || result.Username != "casey" {
			t.Fatalf("callback result = %#v", result)
		}
	})

	t.Run("invalid token", func(t *testing.T) {
		commandsAuthCovSetConfig(t, "https://api.example.test")
		authZWithOpenBrowser(t, func(loginURL string) error {
			resp := authZPostJSON(t, authZCallbackURL(t, loginURL), map[string]string{"token": "bad", "callback_state": authZCallbackState(t, loginURL)})
			_ = resp.Body.Close()
			return nil
		})
		if _, err := runBrowserLogin(nil); err == nil || !strings.Contains(err.Error(), "Invalid token") {
			t.Fatalf("invalid token error = %v", err)
		}
	})

	t.Run("missing token", func(t *testing.T) {
		commandsAuthCovSetConfig(t, "https://api.example.test")
		authZWithOpenBrowser(t, func(loginURL string) error {
			resp := authZPostJSON(t, authZCallbackURL(t, loginURL), map[string]string{"username": "casey", "callback_state": authZCallbackState(t, loginURL)})
			_ = resp.Body.Close()
			return nil
		})
		if _, err := runBrowserLogin(nil); err == nil || !strings.Contains(err.Error(), "OAuth callback") {
			t.Fatalf("missing token error = %v", err)
		}
	})
}
