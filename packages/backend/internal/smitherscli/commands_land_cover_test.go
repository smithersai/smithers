package smitherscli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	incur "github.com/smithersai/incur"
)

func commandsLandCovSetConfig(t *testing.T, apiURL string) {
	t.Helper()
	root := t.TempDir()
	configHome := filepath.Join(root, "config")
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("SMITHERS_AUTH_FILE", filepath.Join(root, "auth.json"))
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	t.Setenv("SMITHERS_TOKEN", "commands_land_cov_token")
	if err := os.MkdirAll(filepath.Join(configHome, "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configHome, "smithers", "config.toon"), []byte("api_url: "+apiURL+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func commandsLandCovInstallFakeJj(t *testing.T) {
	t.Helper()
	binDir := filepath.Join(t.TempDir(), "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'jj 0.99.0\n'
  exit 0
fi
if [ "$1" = "--ignore-working-copy" ]; then
  shift
fi
case "$*" in
  *'change_id ++ "\n"'*)
    printf 'stack1\nstack2\n'
    exit 0
    ;;
esac
if [ "$1" = "log" ] && [ "$2" = "-r" ] && [ "$3" = "@" ]; then
  printf 'current123\tcommit-current\tCurrent change\n'
  exit 0
fi
printf 'unexpected jj args: %s\n' "$*" >&2
exit 1
`
	if err := os.WriteFile(filepath.Join(binDir, "jj"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func commandsLandCovServe(t *testing.T, cli *incur.Cli, argv []string) string {
	t.Helper()
	var stdout bytes.Buffer
	if err := cli.ServeWithOptions(argv, incur.ServeOptions{Stdout: &stdout}); err != nil {
		t.Fatalf("ServeWithOptions(%v) returned error: %v\n%s", argv, err, stdout.String())
	}
	return stdout.String()
}

func TestCommandsLand_Cov_CommandHandlersAndDetails(t *testing.T) {
	commandsLandCovInstallFakeJj(t)
	var seen []string
	var createChanges [][]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.RequestURI())
		if got := r.Header.Get("Authorization"); got != "token commands_land_cov_token" {
			t.Fatalf("Authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/landings":
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("invalid landing create body: %v", err)
			}
			changes := []string{}
			for _, item := range arrayValue(body["change_ids"]) {
				changes = append(changes, stringValue(item))
			}
			createChanges = append(createChanges, changes)
			if body["target_bookmark"] == "" || body["title"] == "" {
				t.Fatalf("landing create body missing fields: %#v", body)
			}
			fmt.Fprintf(w, `{"number":%d,"title":%q,"state":"open","target_bookmark":%q,"change_ids":["%s"]}`,
				len(createChanges), stringValue(body["title"]), stringValue(body["target_bookmark"]), changes[0])
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/landings":
			if r.URL.Query().Get("state") == "merged" && r.URL.Query().Get("limit") != "2" {
				t.Fatalf("landed list query = %s", r.URL.RawQuery)
			}
			if r.URL.Query().Get("cursor") == "" {
				w.Header().Set("Link", `</api/repos/alice/demo/landings?cursor=next>; rel="next"`)
				fmt.Fprint(w, `[{"number":7,"title":"Land feature","state":"open","author":{"login":"alice"}}]`)
				return
			}
			fmt.Fprint(w, `[{"number":8,"title":"Second landing","state":"merged","author":{}}]`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/landings/7":
			fmt.Fprint(w, `{"number":7,"title":"Land feature","state":"open","change_ids":["chg1","chg2"],"author":{"login":"alice"}}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/landings/8":
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"message":"details unavailable"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/landings/7/changes":
			if r.URL.Query().Get("per_page") != "100" {
				t.Fatalf("changes query = %s", r.URL.RawQuery)
			}
			fmt.Fprint(w, `[{"change_id":"chg1","description":"Change one"}]`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/landings/7/reviews":
			fmt.Fprint(w, `[{"type":"approve","body":"looks good"}]`)
		case r.Method == http.MethodGet && r.URL.Path == "/api/repos/alice/demo/landings/7/conflicts":
			fmt.Fprint(w, `{"conflict_status":"clean"}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/landings/7/reviews":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["type"] != "approve" || body["body"] != "ok" || body["commit_id"] != "commit-1" {
				t.Fatalf("review body = %#v", body)
			}
			fmt.Fprint(w, `{"type":"approve"}`)
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/repos/alice/demo/commits/"):
			changeID := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/repos/alice/demo/commits/"), "/statuses")
			fmt.Fprintf(w, `[{"context":"ci","state":"success","change_id":%q}]`, changeID)
		case r.Method == http.MethodPatch && r.URL.Path == "/api/repos/alice/demo/landings/7":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["title"] != "Updated" || body["body"] != "" || body["target_bookmark"] != "release" {
				t.Fatalf("edit body = %#v", body)
			}
			fmt.Fprint(w, `{"number":7,"title":"Updated","state":"open"}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/repos/alice/demo/landings/7/comments":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["body"] != "note" || body["commit_id"] != "commit-1" {
				t.Fatalf("comment body = %#v", body)
			}
			fmt.Fprint(w, `{"id":12,"body":"note"}`)
		case r.Method == http.MethodPut && r.URL.Path == "/api/repos/alice/demo/landings/7/land":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["commit_id"] != "commit-1" {
				t.Fatalf("land body = %#v", body)
			}
			fmt.Fprint(w, `{"number":7,"state":"merged","title":"Land feature"}`)
		case r.Method == http.MethodPut && r.URL.Path == "/api/repos/alice/demo/landings/404/land":
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"message":"missing"}`)
		case r.Method == http.MethodPut && r.URL.Path == "/api/repos/alice/demo/landings/409/land":
			w.WriteHeader(http.StatusConflict)
			fmt.Fprint(w, `{"message":"checks pending"}`)
		default:
			t.Fatalf("unexpected landing request: %s %s", r.Method, r.URL.RequestURI())
		}
	}))
	defer server.Close()
	commandsLandCovSetConfig(t, server.URL)

	var help bytes.Buffer
	if err := landCommand().ServeWithOptions([]string{"--help"}, incur.ServeOptions{Stdout: &help}); err != nil {
		t.Fatalf("land help returned error: %v", err)
	}
	if !strings.Contains(help.String(), "landing") {
		t.Fatalf("land help missing description:\n%s", help.String())
	}

	commandsLandCovServe(t, landCommand(), []string{"create", "--repo", "alice/demo", "--title", "Explicit", "--body", "Body", "--target", "release", "--change-id", "chg-explicit"})
	commandsLandCovServe(t, landCommand(), []string{"create", "--repo", "alice/demo", "--title", "Current", "--target", "main"})
	commandsLandCovServe(t, landCommand(), []string{"create", "--repo", "alice/demo", "--title", "Stack", "--target", "main", "--stack", "--json"})
	if !reflect.DeepEqual(createChanges, [][]string{{"chg-explicit"}, {"current123"}, {"stack1", "stack2"}}) {
		t.Fatalf("create change IDs = %#v", createChanges)
	}

	listed := commandsLandCovServe(t, landCommand(), []string{"list", "--repo", "alice/demo", "--state", "landed", "--limit", "2"})
	if !strings.Contains(listed, "More results available") {
		t.Fatalf("landing list output missing pagination hint:\n%s", listed)
	}
	all := commandsLandCovServe(t, landCommand(), []string{"list", "--repo", "alice/demo", "--all", "--json"})
	if !strings.Contains(all, `"number": 8`) {
		t.Fatalf("landing list --all output = %s", all)
	}
	commandsLandCovServe(t, landCommand(), []string{"view", "7", "--repo", "alice/demo", "--json"})
	review := commandsLandCovServe(t, landCommand(), []string{"review", "7", "--repo", "alice/demo", "--commit", "commit-1", "--approve", "--body", "ok"})
	if !strings.Contains(review, "Submitted approval") {
		t.Fatalf("review output = %q", review)
	}
	checks := commandsLandCovServe(t, landCommand(), []string{"checks", "7", "--repo", "alice/demo"})
	if !strings.Contains(checks, "ci") {
		t.Fatalf("checks output = %q", checks)
	}
	conflicts := commandsLandCovServe(t, landCommand(), []string{"conflicts", "7", "--repo", "alice/demo"})
	if conflicts != "Conflicts: clean\n" {
		t.Fatalf("conflicts output = %q", conflicts)
	}
	commandsLandCovServe(t, landCommand(), []string{"edit", "7", "--repo", "alice/demo", "--title", "Updated", "--body", "", "--target", "release", "--json"})
	comment := commandsLandCovServe(t, landCommand(), []string{"comment", "7", "--repo", "alice/demo", "--commit", "commit-1", "--body", "note"})
	if !strings.Contains(comment, "Added a comment") {
		t.Fatalf("comment output = %q", comment)
	}
	landed := commandsLandCovServe(t, landCommand(), []string{"land", "7", "--repo", "alice/demo", "--commit", "commit-1"})
	if !strings.Contains(landed, "Landed") {
		t.Fatalf("land output = %q", landed)
	}

	for _, tc := range []struct {
		number string
		want   string
	}{
		{"404", "was not found"},
		{"409", "cannot be landed right now"},
	} {
		var stdout bytes.Buffer
		err := landCommand().ServeWithOptions([]string{"land", tc.number, "--repo", "alice/demo", "--commit", "commit-1"}, incur.ServeOptions{Stdout: &stdout})
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("land %s error = %v stdout=%s", tc.number, err, stdout.String())
		}
	}
	if _, err := landingDetails("alice", "demo", 8); err == nil || !strings.Contains(err.Error(), "details unavailable") {
		t.Fatalf("landingDetails error = %v", err)
	}

	for _, want := range []string{
		"POST /api/repos/alice/demo/landings",
		"GET /api/repos/alice/demo/landings/7/changes",
		"GET /api/repos/alice/demo/commits/chg1/statuses",
		"PUT /api/repos/alice/demo/landings/7/land",
	} {
		found := false
		for _, got := range seen {
			if strings.HasPrefix(got, want) {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("server did not see %q; saw %v", want, seen)
		}
	}
}

func TestCommandsLand_Cov_NumberHelpersAndErrors(t *testing.T) {
	if normalizeLandingListState("landed") != "merged" || normalizeLandingListState("open") != "open" {
		t.Fatal("normalizeLandingListState returned unexpected values")
	}
	if number, err := parseLandingNumber("12"); err != nil || number != 12 {
		t.Fatalf("parseLandingNumber valid = (%d, %v)", number, err)
	}
	for _, raw := range []string{"0", "-1", "abc"} {
		if _, err := parseLandingNumber(raw); err == nil || !strings.Contains(err.Error(), "invalid landing request number") {
			t.Fatalf("parseLandingNumber(%q) error = %v", raw, err)
		}
	}

	commandsLandCovSetConfig(t, "http://127.0.0.1:1")
	called := false
	def := landNumberCommand("View test landing", func(owner, repo string, number int, ctx *incur.CommandContext) (any, error) {
		called = true
		if owner != "alice" || repo != "demo" || number != 7 {
			t.Fatalf("handler args = %s/%s #%d", owner, repo, number)
		}
		return "ok", nil
	})
	result, err := def.Handler(&incur.CommandContext{Args: map[string]any{"number": "7"}, Options: map[string]any{"repo": "alice/demo"}})
	if err != nil || result != "ok" || !called {
		t.Fatalf("landNumberCommand handler = (%#v, %v), called=%t", result, err, called)
	}
	if _, err := def.Handler(&incur.CommandContext{Args: map[string]any{"number": "bad"}, Options: map[string]any{"repo": "alice/demo"}}); err == nil {
		t.Fatal("landNumberCommand accepted invalid number")
	}

	withOptions := landNumberCommandWithOptions("Comment", map[string]*incur.JSONSchema{"body": stringSchema("Comment body")}, []string{"body"}, func(owner, repo string, number int, ctx *incur.CommandContext) (any, error) {
		return map[string]any{"body": stringValue(ctx.Options["body"])}, nil
	})
	if withOptions.OptionsSchema.Properties["body"] == nil || !reflect.DeepEqual(withOptions.OptionsSchema.Required, []string{"body"}) {
		t.Fatalf("landNumberCommandWithOptions schema = %#v", withOptions.OptionsSchema)
	}
	result, err = withOptions.Handler(&incur.CommandContext{Args: map[string]any{"number": "9"}, Options: map[string]any{"repo": "alice/demo", "body": "note"}})
	if err != nil || objectValue(result)["body"] != "note" {
		t.Fatalf("landNumberCommandWithOptions handler = (%#v, %v)", result, err)
	}
	if _, err := withOptions.Handler(&incur.CommandContext{Args: map[string]any{"number": "9"}, Options: map[string]any{"repo": "bad"}}); err == nil || !strings.Contains(err.Error(), "Invalid repo format") {
		t.Fatalf("landNumberCommandWithOptions invalid repo error = %v", err)
	}
}
