//go:build linux

package smitherscli

import (
	"os"
	"path/filepath"
	"testing"
)

func installFakeJj(t *testing.T, root string) string {
	t.Helper()
	fakeBin := filepath.Join(root, "bin")
	if err := os.MkdirAll(fakeBin, 0o755); err != nil {
		t.Fatal(err)
	}
	fakeJj := filepath.Join(fakeBin, "jj")
	script := "#!/bin/sh\ncase \"$1 $2 $3\" in\n  '--version  ') echo 'jj 0.33.0' ;;\n  'root  ') pwd ;;\n  'git remote list') echo 'origin git@ssh.smithers.sh:alice/demo.git' ;;\n  'status  ') echo 'The working copy is clean' ;;\n  *) echo \"unexpected jj args: $*\" >&2; exit 1 ;;\nesac\n"
	if err := os.WriteFile(fakeJj, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return fakeBin
}

func TestCollectAgentRepoContextDetectsSmithersRemote(t *testing.T) {
	root := t.TempDir()
	repoDir := filepath.Join(root, "repo")
	configHome := filepath.Join(root, "cfg")
	if err := os.MkdirAll(repoDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(configHome, "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configHome, "smithers", "config.toon"), []byte("api_url: https://api.smithers.sh\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", installFakeJj(t, root))
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	t.Setenv("SMITHERS_TOKEN", "")

	oldwd, _ := os.Getwd()
	if err := os.Chdir(repoDir); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(oldwd)

	context, err := collectAgentRepoContext("")
	if err != nil {
		t.Fatal(err)
	}
	if got := stringValue(context["repoRoot"]); got != repoDir {
		t.Fatalf("repoRoot = %q, want %q", got, repoDir)
	}
	if got := stringValue(context["repoSlug"]); got != "alice/demo" {
		t.Fatalf("repoSlug = %q", got)
	}
	if got := stringValue(context["repoSource"]); got != "detected" {
		t.Fatalf("repoSource = %q", got)
	}
	if remotes := objectValue(context["jjRemotes"]); remotes["ok"] != true {
		t.Fatalf("jjRemotes not ok: %#v", remotes)
	}
}

func TestCollectAgentRepoContextSkipsRemoteCheckWithoutAuth(t *testing.T) {
	root := t.TempDir()
	repoDir := filepath.Join(root, "repo")
	configHome := filepath.Join(root, "cfg")
	if err := os.MkdirAll(repoDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(configHome, "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configHome, "smithers", "config.toon"), []byte("api_url: https://api.smithers.sh\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	t.Setenv("PATH", installFakeJj(t, root))
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	t.Setenv("SMITHERS_TOKEN", "")

	oldwd, _ := os.Getwd()
	if err := os.Chdir(repoDir); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(oldwd)

	context, err := collectAgentRepoContext("alice/demo")
	if err != nil {
		t.Fatal(err)
	}
	auth := objectValue(context["auth"])
	if auth["loggedIn"] == true {
		t.Fatalf("auth unexpectedly logged in: %#v", auth)
	}
	remoteRepo := objectValue(context["remoteRepo"])
	if remoteRepo["checked"] == true {
		t.Fatalf("remote repo should not have been checked without auth: %#v", remoteRepo)
	}
	if message := stringValue(remoteRepo["message"]); message == "" {
		t.Fatalf("remote repo missing skip message: %#v", remoteRepo)
	}
}
