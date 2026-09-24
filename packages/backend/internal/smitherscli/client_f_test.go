package smitherscli

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func clientFToken(apiURL string) *ResolvedAuthToken {
	return &ResolvedAuthToken{AuthTarget: AuthTarget{APIURL: apiURL, Host: "h"}, Source: AuthTokenSourceEnv, Token: "tok"}
}

func clientFSetConfig(t *testing.T, apiURL string) {
	t.Helper()
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	if err := os.MkdirAll(filepath.Join(configHome, "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configHome, "smithers", "config.toon"), []byte("api_url: "+apiURL+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func clientFTruncatedServer(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hj, ok := w.(http.Hijacker)
		if !ok {
			return
		}
		conn, buf, err := hj.Hijack()
		if err != nil {
			return
		}
		_, _ = buf.WriteString("HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\nshort")
		_ = buf.Flush()
		_ = conn.Close()
	})}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return "http://" + ln.Addr().String()
}

func TestClient_F_CloneTargetAndBuildURLDefaults(t *testing.T) {
	clientFSetConfig(t, "https://api.smithers.test")
	owner, repo, cloneURL, err := ResolveRepoCloneTarget("alice/demo", GitProtocolSSH, "")
	if err != nil || owner != "alice" || repo != "demo" {
		t.Fatalf("ResolveRepoCloneTarget = %q/%q %q %v", owner, repo, cloneURL, err)
	}
	if cloneURL != "git@ssh.smithers.test:alice/demo.git" {
		t.Fatalf("ResolveRepoCloneTarget default apiURL clone URL = %q", cloneURL)
	}
}

func TestClient_F_APIRequestErrors(t *testing.T) {
	// NewRequest error (space in URL host)
	if _, err := APIRequest("GET", "/x", nil, clientFToken("http://bad host")); err == nil {
		t.Fatal("APIRequest NewRequest error expected")
	}
	// Do error (unreachable)
	if _, err := APIRequest("GET", "/x", nil, clientFToken("http://127.0.0.1:1")); err == nil {
		t.Fatal("APIRequest Do error expected")
	}
	// ReadAll error on a 2xx response
	if _, err := APIRequest("GET", "/x", nil, clientFToken(clientFTruncatedServer(t))); err == nil {
		t.Fatal("APIRequest ReadAll error expected")
	}
	// Empty 200 body -> nil, nil
	emptyServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer emptyServer.Close()
	if res, err := APIRequest("GET", "/x", nil, clientFToken(emptyServer.URL)); err != nil || res != nil {
		t.Fatalf("APIRequest empty body = %#v, %v", res, err)
	}
	// body marshal path + json decode error on 200
	badJSON := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "not-json")
	}))
	defer badJSON.Close()
	if _, err := APIRequest("POST", "/x", map[string]any{"k": "v"}, clientFToken(badJSON.URL)); err == nil {
		t.Fatal("APIRequest decode error expected")
	}
}

func TestClient_F_APIListErrors(t *testing.T) {
	// NewRequest error
	if _, _, err := APIList("/x", clientFToken("http://bad host")); err == nil {
		t.Fatal("APIList NewRequest error expected")
	}
	// Do error
	if _, _, err := APIList("/x", clientFToken("http://127.0.0.1:1")); err == nil {
		t.Fatal("APIList Do error expected")
	}
	// non-2xx with plain-text body (detail from raw)
	textErr := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, "plain failure text")
	}))
	defer textErr.Close()
	if _, _, err := APIList("/x", clientFToken(textErr.URL)); err == nil {
		t.Fatal("APIList text-detail error expected")
	}
	// 2xx invalid JSON -> decode error
	badJSON := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "not-json")
	}))
	defer badJSON.Close()
	if _, _, err := APIList("/x", clientFToken(badJSON.URL)); err == nil {
		t.Fatal("APIList decode error expected")
	}
}

func TestClient_F_ParseNextCursorNoNext(t *testing.T) {
	if got := ParseNextCursor(`<http://x/y?cursor=a>; rel="prev"`); got != "" {
		t.Fatalf("ParseNextCursor no next = %q", got)
	}
}

func TestClient_F_DetectRepoFromRemotesFallback(t *testing.T) {
	clientFSetConfig(t, "https://api.smithers.test")
	binDir := t.TempDir()
	// No jj on PATH -> RequireJj fails, only git output is consulted.
	gitScript := "#!/bin/sh\n" +
		"printf 'badline\\nupstream https://github.com/other/repo (fetch)\\nbackup https://smithers.test/foo/bar (fetch)\\n'\n"
	if err := os.WriteFile(filepath.Join(binDir, "git"), []byte(gitScript), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)
	owner, repo, ok := detectRepoFromRemotes("smithers.test")
	if !ok || owner != "foo" || repo != "bar" {
		t.Fatalf("detectRepoFromRemotes fallback = %q/%q ok=%v", owner, repo, ok)
	}
}
