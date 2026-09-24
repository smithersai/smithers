package smitherscli

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestRepoConnect_RealJjWritesNoJjConfig runs `repo connect` in a real jj
// repository and asserts the CLI leaves jj's repo config untouched. jj 0.39
// defines no [hooks] table, so any key the CLI writes there is inert; the old
// post-operation push hook never fired.
func TestRepoConnect_RealJjWritesNoJjConfig(t *testing.T) {
	if _, err := exec.LookPath("jj"); err != nil {
		t.Skip("jj is not installed")
	}
	api, github, _ := commandsRepoZSuccessServers(t)
	commandsRepoCovSetConfig(t, api.URL)
	t.Setenv("SMITHERS_GITHUB_API_URL", github.URL)
	t.Setenv("GITHUB_TOKEN", "repo-real-jj-gh")

	root := t.TempDir()
	jjConfig := filepath.Join(root, "jj-config.toml")
	if err := os.WriteFile(jjConfig, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("JJ_CONFIG", jjConfig)
	t.Setenv("JJ_USER", "Test")
	t.Setenv("JJ_EMAIL", "test@example.com")
	repo := filepath.Join(root, "repo")
	jj := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("jj", args...)
		cmd.Dir = repo
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("jj %v: %v\n%s", args, err, out)
		}
		return string(out)
	}
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	jj("git", "init")
	before := jj("config", "list", "--repo")

	commandsRepoZChdir(t, repo)
	commandsRepoZServe(t, "connect", "alice/demo")

	current, err := localRepoConnectionFor(repo)
	if err != nil || current == nil || current.Repo != "alice/demo" {
		t.Fatalf("local connection after connect = %#v, %v", current, err)
	}
	after := jj("config", "list", "--repo")
	if strings.Contains(after, "hooks.") || after != before {
		t.Fatalf("repo connect changed jj repo config:\nbefore:\n%s\nafter:\n%s", before, after)
	}
	if _, err := os.Stat(filepath.Join(repo, ".jj", "config.toml")); !os.IsNotExist(err) {
		t.Fatalf("repo connect wrote .jj/config.toml (stat err = %v)", err)
	}

	commandsRepoZServe(t, "disconnect")
	if after := jj("config", "list", "--repo"); after != before {
		t.Fatalf("repo disconnect changed jj repo config:\n%s", after)
	}
}
