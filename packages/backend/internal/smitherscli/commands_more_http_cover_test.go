package smitherscli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	incur "github.com/smithersai/incur"
)

func commandsMoreHTTPCovSetConfig(t *testing.T, apiURL string) {
	t.Helper()
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("SMITHERS_TOKEN", "commands_more_http_cov_token")
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	if err := os.MkdirAll(filepath.Join(configHome, "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configHome, "smithers", "config.toon"), []byte("api_url: "+apiURL+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func commandsMoreHTTPCovServe(t *testing.T, cli *incur.Cli, argv []string) string {
	t.Helper()
	var stdout bytes.Buffer
	if err := cli.ServeWithOptions(argv, incur.ServeOptions{Stdout: &stdout}); err != nil {
		t.Fatalf("ServeWithOptions(%v) returned error: %v\n%s", argv, err, stdout.String())
	}
	return stdout.String()
}

func TestCommandsMoreHttp_Cov_CommandConstructorsAndHandlers(t *testing.T) {
	var seen []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.RequestURI())
		if r.URL.Path != "/api/alpha/waitlist" {
			if got := r.Header.Get("Authorization"); got != "token commands_more_http_cov_token" {
				t.Errorf("Authorization header = %q for %s", got, r.URL.Path)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodDelete && r.URL.Path == "/api/admin/users/bob":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && r.URL.Path == "/api/alpha/waitlist":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("invalid waitlist body: %v", err)
			}
			if body["email"] != "person@example.com" || body["source"] != "cov" {
				t.Errorf("waitlist body = %#v", body)
			}
			fmt.Fprint(w, `{"joined":true}`)
		case r.Method == http.MethodDelete && r.URL.Path == "/api/orgs/acme/teams/core/members/bob":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPut && r.URL.Path == "/api/orgs/acme/teams/core/repos/alice/demo":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/hooks/9/deliveries/21/redeliver":
			fmt.Fprint(w, `{"replayed":true}`)
		case r.Method == http.MethodDelete && r.URL.Path == "/api/integrations/linear/4":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/actions/runs/99/artifacts":
			fmt.Fprint(w, `[{"name":"artifact.zip"}]`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/releases":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("invalid release body: %v", err)
			}
			if body["tag_name"] != "v1.0.0" || body["draft"] != true {
				t.Errorf("release body = %#v", body)
			}
			fmt.Fprint(w, `{"id":123,"tag_name":"v1.0.0"}`)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.RequestURI())
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"missing"}`)
		}
	}))
	defer server.Close()
	commandsMoreHTTPCovSetConfig(t, server.URL)

	for _, tc := range []struct {
		name string
		cli  *incur.Cli
		want string
	}{
		{"admin", adminCommand(), "Admin commands"},
		{"beta", betaCommand(), "closed alpha"},
		{"org", orgCommand(), "Organization"},
		{"webhook", webhookCommand(), "webhooks"},
		{"extension", extensionCommand(), "integrations"},
		{"artifact", artifactCommand(), "artifacts"},
	} {
		t.Run("help "+tc.name, func(t *testing.T) {
			var stdout bytes.Buffer
			if err := tc.cli.ServeWithOptions([]string{"--help"}, incur.ServeOptions{Stdout: &stdout}); err != nil {
				t.Fatalf("%s help returned error: %v", tc.name, err)
			}
			if !strings.Contains(stdout.String(), tc.want) {
				t.Fatalf("%s help missing %q:\n%s", tc.name, tc.want, stdout.String())
			}
		})
	}

	commandsMoreHTTPCovServe(t, adminCommand(), []string{"user", "delete", "bob", "--yes", "--json"})
	commandsMoreHTTPCovServe(t, betaCommand(), []string{"waitlist", "join", "--email", " person@example.com ", "--note", "hello", "--source", " cov ", "--json"})
	commandsMoreHTTPCovServe(t, orgCommand(), []string{"team", "member", "remove", "acme", "core", "bob", "--json"})
	commandsMoreHTTPCovServe(t, orgCommand(), []string{"team", "repo", "add", "acme", "core", "alice/demo", "--json"})
	commandsMoreHTTPCovServe(t, webhookCommand(), []string{"deliveries", "9", "--replay", "21", "--repo", "alice/demo", "--json"})
	commandsMoreHTTPCovServe(t, extensionCommand(), []string{"linear", "remove", "4", "--json"})
	commandsMoreHTTPCovServe(t, artifactCommand(), []string{"list", "99", "--repo", "alice/demo", "--json"})

	want := []string{
		"DELETE /api/admin/users/bob",
		"POST /api/alpha/waitlist",
		"DELETE /api/orgs/acme/teams/core/members/bob",
		"PUT /api/orgs/acme/teams/core/repos/alice/demo",
		"POST /api/repos/alice/demo/hooks/9/deliveries/21/redeliver",
		"DELETE /api/integrations/linear/4",
		"GET /api/repos/alice/demo/actions/runs/99/artifacts",
	}
	for _, expected := range want {
		found := false
		for _, got := range seen {
			if strings.HasPrefix(got, expected) {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("server did not see %q; saw %v", expected, seen)
		}
	}
}

func TestCommandsMoreHttp_Cov_FileTransferHelpers(t *testing.T) {
	downloadServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprint(w, "nope")
	}))
	defer downloadServer.Close()
	if err := downloadFileLimit(downloadServer.URL, filepath.Join(t.TempDir(), "out.bin"), 10); err == nil || !strings.Contains(err.Error(), "failed to download artifact") {
		t.Fatalf("downloadFileLimit status error = %v", err)
	}
}

func TestCommandsMoreHttp_Cov_UnauthenticatedRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/public":
			if got := r.Header.Get("Authorization"); got != "" {
				t.Errorf("unauthenticated request sent auth header %q", got)
			}
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("invalid public body: %v", err)
			}
			fmt.Fprint(w, `{"ok":true}`)
		case r.URL.Path == "/public-error-json":
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, `{"message":"bad public request"}`)
		case r.URL.Path == "/public-error-text":
			w.WriteHeader(http.StatusBadGateway)
			fmt.Fprint(w, `upstream unavailable`)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"missing"}`)
		}
	}))
	defer server.Close()
	commandsMoreHTTPCovSetConfig(t, server.URL)

	result, err := unauthenticatedJSONRequest(http.MethodPost, "/public", map[string]any{"name": "cov"})
	if err != nil || objectValue(result)["ok"] != true {
		t.Fatalf("unauthenticatedJSONRequest success = (%#v, %v)", result, err)
	}
	if _, err = unauthenticatedJSONRequest(http.MethodGet, "/public-error-json", nil); err == nil || !strings.Contains(err.Error(), "bad public request") {
		t.Fatalf("unauthenticatedJSONRequest JSON error = %v", err)
	}
	if _, err = unauthenticatedJSONRequest(http.MethodGet, "/public-error-text", nil); err == nil || !strings.Contains(err.Error(), "upstream unavailable") {
		t.Fatalf("unauthenticatedJSONRequest text error = %v", err)
	}
	if _, err = unauthenticatedJSONRequest(http.MethodPost, "/public", map[string]any{"bad": func() {}}); err == nil {
		t.Fatal("unauthenticatedJSONRequest accepted unmarshalable body")
	}

}
