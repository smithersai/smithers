package services

import (
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

func TestBuildPairAgentCommand_VMPrefix(t *testing.T) {
	const vmPrefix = "export HOME=/root PATH=/usr/local/bin:/root/.bun/bin:/usr/bin:/bin; "

	tests := []struct {
		name       string
		provider   string
		local      bool
		wantPrefix bool // expect the VM HOME/PATH prefix
		wantSub    string
	}{
		{
			name:       "codex VM keeps root env prefix",
			provider:   "codex",
			local:      false,
			wantPrefix: true,
			wantSub:    "codex exec --sandbox workspace-write --ask-for-approval never --skip-git-repo-check -C",
		},
		{
			name:       "codex local has no root env prefix",
			provider:   "codex",
			local:      true,
			wantPrefix: false,
			wantSub:    "codex exec --sandbox workspace-write --ask-for-approval never --skip-git-repo-check -C",
		},
		{
			name:       "empty provider defaults to codex (VM)",
			provider:   "",
			local:      false,
			wantPrefix: true,
			wantSub:    "codex exec",
		},
		{
			name:       "unknown provider falls back to codex",
			provider:   "totally-unknown",
			local:      false,
			wantPrefix: true,
			wantSub:    "codex exec",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cmd := buildPairAgentCommand(tt.provider, "/work/dir", "do the thing", pairAgentSnapshot{Doc: "# shared\n"}, tt.local)

			hasPrefix := strings.HasPrefix(cmd, vmPrefix)
			if hasPrefix != tt.wantPrefix {
				t.Fatalf("prefix presence = %v, want %v\ncmd: %s", hasPrefix, tt.wantPrefix, cmd)
			}
			if tt.wantPrefix && hasPrefix && tt.local {
				t.Fatalf("local command must NOT carry the VM root env prefix\ncmd: %s", cmd)
			}
			if !strings.Contains(cmd, tt.wantSub) {
				t.Fatalf("command missing %q\ncmd: %s", tt.wantSub, cmd)
			}
			// Every provider/path must emit the full protocol so parsing works.
			for _, marker := range []string{"===REPLY===", "===OUTPUT===", "===FILES===", "===FILE_CONTENTS===", "===STATUS===", "===DOC==="} {
				if !strings.Contains(cmd, marker) {
					t.Fatalf("command missing protocol marker %q\ncmd: %s", marker, cmd)
				}
			}
			// The workdir must be single-quoted into the `cd`.
			if !strings.Contains(cmd, "cd '/work/dir';") {
				t.Fatalf("command missing quoted cd into workdir\ncmd: %s", cmd)
			}
			// The instruction text must be embedded.
			if !strings.Contains(cmd, "do the thing") {
				t.Fatalf("command missing prompt text\ncmd: %s", cmd)
			}
		})
	}
}

func TestBuildPairAgentCommand_MaterializesRoomSnapshotAndSandboxesCodex(t *testing.T) {
	const workdir = "/opt/pair/workspace"
	const prompt = "rename Foo to Bar"

	snapshot := pairAgentSnapshot{
		Doc: "# shared\n",
		Files: map[string]string{
			"src/app.go":  "package main\n",
			"../escape":   "bad\n",
			".git/config": "bad\n",
		},
	}
	got := buildPairAgentCommand("codex", workdir, prompt, snapshot, false)

	docB64 := base64.StdEncoding.EncodeToString([]byte(snapshot.Doc))
	fileB64 := base64.StdEncoding.EncodeToString([]byte(snapshot.Files["src/app.go"]))
	if !strings.Contains(got, "printf '%s' '"+docB64+"' | base64 -d > 'shared.md';") {
		t.Fatalf("command does not materialize shared.md\ncmd: %s", got)
	}
	if !strings.Contains(got, "mkdir -p 'src'; printf '%s' '"+fileB64+"' | base64 -d > 'src/app.go';") {
		t.Fatalf("command does not materialize room file\ncmd: %s", got)
	}
	if strings.Contains(got, "dangerously-bypass-approvals-and-sandbox") {
		t.Fatalf("command bypasses Codex sandbox\ncmd: %s", got)
	}
	if !strings.Contains(got, "codex exec --sandbox workspace-write --ask-for-approval never --skip-git-repo-check -C") {
		t.Fatalf("command missing sandboxed Codex invocation\ncmd: %s", got)
	}
	if !strings.Contains(got, "pair_before=$(mktemp") || !strings.Contains(got, "pair_after=$(mktemp") {
		t.Fatalf("command does not capture a before/after file baseline\ncmd: %s", got)
	}
	if !strings.Contains(got, "awk -F '\\t'") || !strings.Contains(got, "cat \"$pair_changed\"") {
		t.Fatalf("command does not report only post-agent file changes\ncmd: %s", got)
	}
	if !strings.Contains(got, "exit \"$cx_status\"") {
		t.Fatalf("command does not preserve agent exit status\ncmd: %s", got)
	}
	if strings.Contains(got, "../escape") || strings.Contains(got, ".git/config") {
		t.Fatalf("command materialized unsafe path\ncmd: %s", got)
	}
}

func TestNormalizePairAgentProvider(t *testing.T) {
	tests := []struct {
		name      string
		requested string
		fallback  string
		want      string
		wantErr   bool
	}{
		{name: "empty defaults to codex", want: "codex"},
		{name: "explicit codex lowercased", requested: " CoDeX ", want: "codex"},
		{name: "fallback codex", fallback: "codex", want: "codex"},
		{name: "rejects claude override", requested: "claude", wantErr: true},
		{name: "rejects unsafe fallback", fallback: "gemini", wantErr: true},
		{name: "rejects unknown", requested: "anything", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := normalizePairAgentProvider(tt.requested, tt.fallback)
			if tt.wantErr {
				if !errors.Is(err, ErrUnsupportedPairProvider) {
					t.Fatalf("err = %v, want ErrUnsupportedPairProvider", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected err: %v", err)
			}
			if got != tt.want {
				t.Fatalf("provider = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestParsePairAgentOutput(t *testing.T) {
	doc := "# shared.md\nupdated content\n"
	docB64 := base64.StdEncoding.EncodeToString([]byte(doc))

	stdout := strings.Join([]string{
		"===REPLY===",
		"Renamed Foo to Bar across the package.",
		"===OUTPUT===",
		"...lots of codex tool output...",
		"===FILES===",
		"pkg/foo.go",
		"pkg/bar.go",
		".git/index", // must be skipped by shouldSkipPairPath
		"../escape",  // must be skipped by cleanPairMaterializedPath
		"===FILE_CONTENTS===",
		"pkg/foo.go\t" + base64.StdEncoding.EncodeToString([]byte("package pkg\n")),
		"pkg/bar.go\t" + base64.StdEncoding.EncodeToString([]byte("package pkg\n")),
		".git/index\t" + base64.StdEncoding.EncodeToString([]byte("bad")),
		"../escape\t" + base64.StdEncoding.EncodeToString([]byte("bad")),
		"===STATUS===",
		"0",
		"===DOC===",
		docB64,
	}, "\n")

	res := parsePairAgentOutput(stdout, "stderr text")

	if res.Reply != "Renamed Foo to Bar across the package." {
		t.Fatalf("reply = %q", res.Reply)
	}
	if !strings.Contains(res.Output, "lots of codex tool output") {
		t.Fatalf("output = %q", res.Output)
	}
	if strings.Contains(res.Output, "===FILES===") || strings.Contains(res.Output, "===OUTPUT===") {
		t.Fatalf("output leaked protocol markers: %q", res.Output)
	}
	if res.NewDoc != doc {
		t.Fatalf("newDoc = %q, want %q", res.NewDoc, doc)
	}
	wantFiles := []string{"pkg/foo.go", "pkg/bar.go"}
	if len(res.ChangedFiles) != len(wantFiles) {
		t.Fatalf("changedFiles = %v, want %v", res.ChangedFiles, wantFiles)
	}
	for i, f := range wantFiles {
		if res.ChangedFiles[i] != f {
			t.Fatalf("changedFiles[%d] = %q, want %q", i, res.ChangedFiles[i], f)
		}
	}
	for _, f := range res.ChangedFiles {
		if strings.HasPrefix(f, ".git/") {
			t.Fatalf("heavy/ignored path leaked into changedFiles: %q", f)
		}
	}
	if res.ChangedFileContents["pkg/foo.go"] != "package pkg\n" {
		t.Fatalf("changed file content not parsed: %#v", res.ChangedFileContents)
	}
	if _, ok := res.ChangedFileContents[".git/index"]; ok {
		t.Fatalf("heavy/ignored path leaked into changed file contents: %#v", res.ChangedFileContents)
	}
	if _, ok := res.ChangedFileContents["../escape"]; ok {
		t.Fatalf("unsafe path leaked into changed file contents: %#v", res.ChangedFileContents)
	}
	if res.ExitCode != 0 {
		t.Fatalf("exitCode = %d, want 0", res.ExitCode)
	}
}

type pairSandboxFunc func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error)

func (f pairSandboxFunc) Execute(ctx context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
	return f(ctx, vmID, req)
}

func TestExecDispatcherRun_ReturnsErrorForNonZeroAgentExit(t *testing.T) {
	status := int32(7)
	dispatcher := execDispatcher{
		sandbox: pairSandboxFunc(func(context.Context, string, sandbox.ExecRequest) (sandbox.ExecResult, error) {
			return sandbox.ExecResult{
				Stdout: strings.Join([]string{
					"===REPLY===",
					"Updated the repo.",
					"===OUTPUT===",
					"codex failed",
					"===FILES===",
					"===FILE_CONTENTS===",
					"===STATUS===",
					"7",
					"===DOC===",
				}, "\n"),
				StatusCode: &status,
			}, nil
		}),
		vmID:     "vm-1",
		workdir:  "/work",
		provider: "codex",
	}

	result, err := dispatcher.Run(context.Background(), "do it", pairAgentSnapshot{Doc: "# doc\n"})
	if err == nil || !strings.Contains(err.Error(), "status 7") {
		t.Fatalf("err = %v, want status 7", err)
	}
	if result.ExitCode != 7 {
		t.Fatalf("exitCode = %d, want 7", result.ExitCode)
	}
	if !strings.Contains(result.Output, "codex failed") {
		t.Fatalf("output = %q", result.Output)
	}
}

func TestParsePairAgentOutput_Defaults(t *testing.T) {
	// No markers at all: reply defaults, output falls back to stderr.
	res := parsePairAgentOutput("", "boom: command not found")
	if res.Reply != "Updated the repo." {
		t.Fatalf("reply default = %q", res.Reply)
	}
	if res.Output != "boom: command not found" {
		t.Fatalf("output fallback = %q", res.Output)
	}
	if res.NewDoc != "" {
		t.Fatalf("newDoc should be empty, got %q", res.NewDoc)
	}
	if len(res.ChangedFiles) != 0 {
		t.Fatalf("changedFiles should be empty, got %v", res.ChangedFiles)
	}
}

func TestParsePairAgentOutput_ReplyTruncated(t *testing.T) {
	long := strings.Repeat("x", 500)
	stdout := "===REPLY===\n" + long + "\n===OUTPUT===\nout\n===FILES===\n===DOC===\n"
	res := parsePairAgentOutput(stdout, "")
	if len(res.Reply) != 400 {
		t.Fatalf("reply length = %d, want 400 (truncated)", len(res.Reply))
	}
}

func TestPairUnifiedFileDiff_ModifiedFile(t *testing.T) {
	diff := pairUnifiedFileDiff("src/app.go", "old\n", "new\n", false)
	for _, want := range []string{
		"diff --git a/src/app.go b/src/app.go\n",
		"--- a/src/app.go\n",
		"+++ b/src/app.go\n",
		"@@ -1,1 +1,1 @@\n",
		"-old\n",
		"+new\n",
	} {
		if !strings.Contains(diff, want) {
			t.Fatalf("diff missing %q\n%s", want, diff)
		}
	}
}

func TestPairUnifiedFileDiff_AddedFile(t *testing.T) {
	diff := pairUnifiedFileDiff("src/new.go", "", "package main\n", true)
	for _, want := range []string{
		"diff --git a/src/new.go b/src/new.go\n",
		"new file mode 100644\n",
		"--- /dev/null\n",
		"+++ b/src/new.go\n",
		"@@ -1,0 +1,1 @@\n",
		"+package main\n",
	} {
		if !strings.Contains(diff, want) {
			t.Fatalf("diff missing %q\n%s", want, diff)
		}
	}
}
