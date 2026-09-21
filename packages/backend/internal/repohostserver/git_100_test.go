package repohostserver

import (
	"context"
	"io"
	"os/exec"
	"strings"
	"testing"
)

func TestGit_H_StreamGitRPCReportsStdinPipeError(t *testing.T) {
	original := streamGitCommandContext
	streamGitCommandContext = func(ctx context.Context, name string, args ...string) *exec.Cmd {
		cmd := exec.CommandContext(ctx, name, args...)
		cmd.Stdin = strings.NewReader("already set")
		return cmd
	}
	t.Cleanup(func() { streamGitCommandContext = original })

	err := streamGitRPC(context.Background(), t.TempDir(), "upload-pack", nil, io.Discard)
	if err == nil {
		t.Fatal("expected stdin pipe error")
	}
	if !strings.Contains(err.Error(), "open git stdin") {
		t.Fatalf("unexpected error: %v", err)
	}
}
