package worker

import (
	"encoding/base64"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

func TestCloneArgs(t *testing.T) {
	for _, tc := range []struct {
		name string
		spec sandbox.GitRepositorySpec
		want []string
	}{
		{
			name: "default clone is shallow",
			spec: sandbox.GitRepositorySpec{},
			want: []string{"clone", "--depth", "200", "--", "https://host/o/r.git", "/workspace"},
		},
		{
			name: "revision still selects the branch",
			spec: sandbox.GitRepositorySpec{Rev: "main"},
			want: []string{"clone", "--depth", "200", "--branch", "main", "--", "https://host/o/r.git", "/workspace"},
		},
		{
			name: "explicit depth overrides the default",
			spec: sandbox.GitRepositorySpec{Depth: 1},
			want: []string{"clone", "--depth", "1", "--", "https://host/o/r.git", "/workspace"},
		},
		{
			name: "opted-out repository clones every commit",
			spec: sandbox.GitRepositorySpec{Depth: sandbox.FullCloneDepth},
			want: []string{"clone", "--", "https://host/o/r.git", "/workspace"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := cloneArgs(tc.spec, "https://host/o/r.git", "/workspace")
			if strings.Join(got, " ") != strings.Join(tc.want, " ") {
				t.Fatalf("cloneArgs = %q, want %q", got, tc.want)
			}
		})
	}
}

// A clone credential must never ride WithExecEnv: that channel persists into
// runtime state and logs, the reason Exec refuses request secrets. The token
// travels in a guest file the env names only by path.
func TestClonePlanKeepsCredentialOutOfExecEnv(t *testing.T) {
	const token = "ghp_clone_secret_sentinel"
	plan, err := planClone(sandbox.GitRepositorySpec{Repo: "https://x-access-token:" + token + "@github.com/o/r.git"},
		map[string]string{"HTTPS_PROXY": "http://127.0.0.1:3128"}, "/run/plue-git-credential-abc")
	if err != nil {
		t.Fatal(err)
	}
	for key, value := range plan.env {
		if strings.Contains(value, token) || strings.Contains(value, base64.StdEncoding.EncodeToString([]byte("x-access-token:"+token))) {
			t.Fatalf("exec env %s carries the clone credential", key)
		}
	}
	if strings.Contains(strings.Join(plan.args, " "), token) {
		t.Fatalf("clone args carry the credential: %q", plan.args)
	}
	if plan.env["GIT_CONFIG_KEY_0"] != "include.path" || plan.env["GIT_CONFIG_VALUE_0"] != "/run/plue-git-credential-abc/config" {
		t.Fatalf("env must include the credential file by path, got %v", plan.env)
	}
	if plan.env["HTTPS_PROXY"] != "http://127.0.0.1:3128" {
		t.Fatalf("proxy env dropped: %v", plan.env)
	}
	want := base64.StdEncoding.EncodeToString([]byte("x-access-token:" + token))
	if !strings.Contains(string(plan.credentialConfig), "Authorization: Basic "+want) {
		t.Fatalf("credential config lacks the auth header: %q", plan.credentialConfig)
	}
	if plan.args[len(plan.args)-2] != "https://github.com/o/r.git" || plan.args[len(plan.args)-1] != "/workspace/r" {
		t.Fatalf("clone args = %q", plan.args)
	}
}

func TestClonePlanWithoutCredentialWritesNoFile(t *testing.T) {
	plan, err := planClone(sandbox.GitRepositorySpec{Repo: "https://github.com/o/public.git", Path: "/src"}, nil, "/run/unused")
	if err != nil {
		t.Fatal(err)
	}
	if plan.credentialConfig != nil || len(plan.env) != 0 {
		t.Fatalf("public clone must carry no credential, got env=%v config=%q", plan.env, plan.credentialConfig)
	}
	if plan.args[len(plan.args)-1] != "/src" {
		t.Fatalf("clone args = %q", plan.args)
	}
}
