package smitherscli

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	incur "github.com/smithersai/incur"
)

func landFSetConfig(t *testing.T, apiURL string) {
	t.Helper()
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	t.Setenv("SMITHERS_TEST_CREDENTIAL_STORE_FILE", "")
	t.Setenv("SMITHERS_AUTH_FILE", filepath.Join(configHome, "auth.json"))
	t.Setenv("SMITHERS_TOKEN", "tok")
	if err := os.MkdirAll(filepath.Join(configHome, "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configHome, "smithers", "config.toon"), []byte("api_url: "+apiURL+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func landFServe(t *testing.T, argv ...string) error {
	t.Helper()
	var out strings.Builder
	return landCommand().ServeWithOptions(argv, incur.ServeOptions{Stdout: &out, Stderr: &out})
}

type landFServer struct {
	failSuffix    string
	emptyConflict bool
}

func (s *landFServer) start(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if s.failSuffix != "" && strings.HasSuffix(path, s.failSuffix) {
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"message":"forced failure"}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(path, "/statuses"):
			fmt.Fprint(w, `[{"context":"ci","state":"success"}]`)
		case strings.HasSuffix(path, "/changes"):
			fmt.Fprint(w, `[]`)
		case strings.HasSuffix(path, "/reviews"):
			if r.Method == http.MethodPost {
				fmt.Fprint(w, `{"id":1,"type":"approve"}`)
			} else {
				fmt.Fprint(w, `[]`)
			}
		case strings.HasSuffix(path, "/conflicts"):
			if s.emptyConflict {
				fmt.Fprint(w, `{}`)
			} else {
				fmt.Fprint(w, `{"conflict_status":"clean"}`)
			}
		case strings.HasSuffix(path, "/comments"):
			fmt.Fprint(w, `{"id":1}`)
		case strings.HasSuffix(path, "/land"):
			fmt.Fprint(w, `{"number":5,"state":"landed"}`)
		case strings.HasSuffix(path, "/landings"):
			if r.Method == http.MethodPost {
				fmt.Fprint(w, `{"number":5,"title":"t"}`)
				return
			}
			if r.URL.Query().Get("cursor") == "" {
				w.Header().Set("Link", `<`+r.URL.String()+`&cursor=next2>; rel="next"`)
			}
			fmt.Fprint(w, `[{"number":5,"title":"t","state":"open","change_ids":["chg1"]}]`)
		default:
			fmt.Fprint(w, `{"number":5,"title":"t","state":"open","change_ids":["chg1"]}`)
		}
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func TestCommandsLand_F_CreateChangeResolution(t *testing.T) {
	jjFInstall(t)
	landFSetConfig(t, "http://127.0.0.1:1")

	t.Setenv("JJF_FAIL", "log -r")
	if err := landFServe(t, "create", "--title", "X", "--repo", "alice/demo"); err == nil {
		t.Fatal("create current-change error expected")
	}
	if err := landFServe(t, "create", "--title", "X", "--stack", "--repo", "alice/demo"); err == nil {
		t.Fatal("create stack error expected")
	}
	t.Setenv("JJF_FAIL", "")

	// explicit change, bad repo -> ResolveRepoRef error
	t.Setenv("PATH", t.TempDir())
	if err := landFServe(t, "create", "--title", "X", "--change", "chg1", "--repo", "badformat"); err == nil {
		t.Fatal("create resolve-repo error expected")
	}
	// explicit change, unreachable API -> APIRequest error
	if err := landFServe(t, "create", "--title", "X", "--change", "chg1", "--repo", "alice/demo"); err == nil {
		t.Fatal("create APIRequest error expected")
	}
}

func TestCommandsLand_F_CreateSuccess(t *testing.T) {
	srv := &landFServer{}
	url := srv.start(t)
	landFSetConfig(t, url)
	t.Setenv("PATH", t.TempDir())
	if err := landFServe(t, "create", "--title", "X", "--change", "chg1", "--repo", "alice/demo", "--format", "json"); err != nil {
		t.Fatalf("create explicit = %v", err)
	}
	if err := landFServe(t, "create", "--title", "X", "--change", "chg1", "--repo", "alice/demo"); err != nil {
		t.Fatalf("create human = %v", err)
	}
}

func TestCommandsLand_F_ListBranches(t *testing.T) {
	srv := &landFServer{}
	url := srv.start(t)
	landFSetConfig(t, url)
	t.Setenv("PATH", t.TempDir())

	// no cursor supplied -> server returns a next cursor
	if err := landFServe(t, "list", "--repo", "alice/demo", "--format", "json"); err != nil {
		t.Fatalf("list json cursor = %v", err)
	}
	if err := landFServe(t, "list", "--repo", "alice/demo"); err != nil {
		t.Fatalf("list human cursor = %v", err)
	}
	// cursor supplied -> server returns no next cursor
	if err := landFServe(t, "list", "--repo", "alice/demo", "--cursor", "c1", "--format", "toon"); err != nil {
		t.Fatalf("list toon no-cursor = %v", err)
	}
	if err := landFServe(t, "list", "--repo", "alice/demo", "--cursor", "c1", "--format", "json"); err != nil {
		t.Fatalf("list json no-cursor = %v", err)
	}
	if err := landFServe(t, "list", "--repo", "alice/demo", "--cursor", "c1"); err != nil {
		t.Fatalf("list human no-cursor = %v", err)
	}
	// --all paths
	if err := landFServe(t, "list", "--repo", "alice/demo", "--all", "--format", "toon"); err != nil {
		t.Fatalf("list all toon = %v", err)
	}
	if err := landFServe(t, "list", "--repo", "alice/demo", "--all", "--format", "json"); err != nil {
		t.Fatalf("list all json = %v", err)
	}
	if err := landFServe(t, "list", "--repo", "alice/demo", "--all", "--state", "all"); err != nil {
		t.Fatalf("list all human = %v", err)
	}
}

func TestCommandsLand_F_ListErrors(t *testing.T) {
	landFSetConfig(t, "http://127.0.0.1:1")
	t.Setenv("PATH", t.TempDir())
	if err := landFServe(t, "list", "--repo", "badformat"); err == nil {
		t.Fatal("list resolve-repo error expected")
	}
	if err := landFServe(t, "list", "--repo", "alice/demo"); err == nil {
		t.Fatal("list APIList error expected")
	}
	if err := landFServe(t, "list", "--repo", "alice/demo", "--all"); err == nil {
		t.Fatal("list --all error expected")
	}
}

func TestCommandsLand_F_ViewChecksConflicts(t *testing.T) {
	srv := &landFServer{}
	url := srv.start(t)
	landFSetConfig(t, url)
	t.Setenv("PATH", t.TempDir())

	// view success (human + explicit)
	if err := landFServe(t, "view", "5", "--repo", "alice/demo"); err != nil {
		t.Fatalf("view human = %v", err)
	}
	if err := landFServe(t, "view", "5", "--repo", "alice/demo", "--format", "json"); err != nil {
		t.Fatalf("view explicit = %v", err)
	}
	// landingDetails deep errors
	for _, suffix := range []string{"/landings/5", "/changes", "/reviews", "/conflicts"} {
		srv.failSuffix = suffix
		if err := landFServe(t, "view", "5", "--repo", "alice/demo"); err == nil {
			t.Fatalf("view should fail for suffix %s", suffix)
		}
	}
	srv.failSuffix = ""

	// checks success + statuses error + landing error
	if err := landFServe(t, "checks", "5", "--repo", "alice/demo"); err != nil {
		t.Fatalf("checks human = %v", err)
	}
	if err := landFServe(t, "checks", "5", "--repo", "alice/demo", "--format", "json"); err != nil {
		t.Fatalf("checks explicit = %v", err)
	}
	srv.failSuffix = "/statuses"
	if err := landFServe(t, "checks", "5", "--repo", "alice/demo"); err == nil {
		t.Fatal("checks statuses error expected")
	}
	srv.failSuffix = "/landings/5"
	if err := landFServe(t, "checks", "5", "--repo", "alice/demo"); err == nil {
		t.Fatal("checks landing error expected")
	}
	srv.failSuffix = ""

	// conflicts success (human + explicit)
	if err := landFServe(t, "conflicts", "5", "--repo", "alice/demo"); err != nil {
		t.Fatalf("conflicts human = %v", err)
	}
	if err := landFServe(t, "conflicts", "5", "--repo", "alice/demo", "--format", "json"); err != nil {
		t.Fatalf("conflicts explicit = %v", err)
	}
	srv.failSuffix = "/conflicts"
	if err := landFServe(t, "conflicts", "5", "--repo", "alice/demo"); err == nil {
		t.Fatal("conflicts error expected")
	}
	srv.failSuffix = ""

	// empty conflict_status -> "unknown"
	srv.emptyConflict = true
	if err := landFServe(t, "conflicts", "5", "--repo", "alice/demo"); err != nil {
		t.Fatalf("conflicts empty status = %v", err)
	}
	srv.emptyConflict = false
}

func TestCommandsLand_F_ReviewEditCommentLand(t *testing.T) {
	srv := &landFServer{}
	url := srv.start(t)
	landFSetConfig(t, url)
	t.Setenv("PATH", t.TempDir())

	// review success (approve human + explicit)
	if err := landFServe(t, "review", "5", "--approve", "--commit", "commit-1", "--repo", "alice/demo"); err != nil {
		t.Fatalf("review human = %v", err)
	}
	if err := landFServe(t, "review", "5", "--approve", "--commit", "commit-1", "--repo", "alice/demo", "--format", "json"); err != nil {
		t.Fatalf("review explicit = %v", err)
	}
	// edit success + comment success + land success
	if err := landFServe(t, "edit", "5", "--title", "New", "--repo", "alice/demo"); err != nil {
		t.Fatalf("edit human = %v", err)
	}
	if err := landFServe(t, "comment", "5", "--body", "hi", "--commit", "commit-1", "--repo", "alice/demo", "--format", "json"); err != nil {
		t.Fatalf("comment explicit = %v", err)
	}
	if err := landFServe(t, "land", "5", "--commit", "commit-1", "--repo", "alice/demo"); err != nil {
		t.Fatalf("land human = %v", err)
	}
	if err := landFServe(t, "land", "5", "--commit", "commit-1", "--repo", "alice/demo", "--format", "json"); err != nil {
		t.Fatalf("land explicit = %v", err)
	}

	// error paths
	srv.failSuffix = "/reviews"
	if err := landFServe(t, "review", "5", "--commit", "commit-1", "--repo", "alice/demo"); err == nil {
		t.Fatal("review error expected")
	}
	srv.failSuffix = "/landings/5"
	if err := landFServe(t, "edit", "5", "--title", "X", "--repo", "alice/demo"); err == nil {
		t.Fatal("edit error expected")
	}
	srv.failSuffix = "/comments"
	if err := landFServe(t, "comment", "5", "--body", "x", "--commit", "commit-1", "--repo", "alice/demo"); err == nil {
		t.Fatal("comment error expected")
	}
	srv.failSuffix = "/land"
	if err := landFServe(t, "land", "5", "--commit", "commit-1", "--repo", "alice/demo"); err == nil {
		t.Fatal("land error expected")
	}
	srv.failSuffix = ""
}
