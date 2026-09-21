package smitherscli

import (
	"bytes"
	"io"
	"os"
	"strings"
	"testing"

	incur "github.com/smithersai/incur"
)

func commandsCompletionCovCaptureStdout(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	defer func() { os.Stdout = old }()
	fn()
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

func TestCommandsCompletion_Cov_CommandAndMetadata(t *testing.T) {
	metadata := completionCommandMetadata()
	for _, want := range []string{"workspace", "artifact", "agent) session list view run chat"} {
		if !strings.Contains(metadata, want) {
			t.Fatalf("completion metadata missing %q:\n%s", want, metadata)
		}
	}

	var help bytes.Buffer
	if err := completionCommand().ServeWithOptions([]string{"--help"}, incur.ServeOptions{Stdout: &help}); err != nil {
		t.Fatalf("completion help returned error: %v", err)
	}
	if !strings.Contains(help.String(), "Generate shell completions") {
		t.Fatalf("completion help missing description:\n%s", help.String())
	}

	out := commandsCompletionCovCaptureStdout(t, func() {
		if err := completionCommand().ServeWithOptions([]string{"bash"}, incur.ServeOptions{}); err != nil {
			t.Fatalf("completion bash returned error: %v", err)
		}
	})
	if !strings.Contains(out, "smithers commands:") || !strings.Contains(out, "smithers") {
		t.Fatalf("completion output missing registration or metadata:\n%s", out)
	}

	var stderr bytes.Buffer
	err := completionCommand().ServeWithOptions([]string{"powershell"}, incur.ServeOptions{Stdout: &stderr})
	if err == nil || (!strings.Contains(err.Error(), "Unknown shell") && !strings.Contains(err.Error(), "enum values")) {
		t.Fatalf("expected invalid shell error, got %v", err)
	}
	if !strings.Contains(stderr.String(), "Unknown shell") && !strings.Contains(stderr.String(), "enum values") {
		t.Fatalf("invalid shell output missing error:\n%s", stderr.String())
	}
}
