package repohostserver

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

type gitCovErrReader struct{}

func (gitCovErrReader) Read([]byte) (int, error) {
	return 0, errors.New("read exploded")
}

type gitCovErrWriter struct{}

func (gitCovErrWriter) Write([]byte) (int, error) {
	return 0, errors.New("write exploded")
}

func TestGit_Cov_StreamGitRPCReportsStartError(t *testing.T) {
	t.Setenv("PATH", t.TempDir())

	err := streamGitRPC(context.Background(), t.TempDir(), "upload-pack", nil, io.Discard)
	if err == nil {
		t.Fatal("expected start error")
	}
	if !strings.Contains(err.Error(), "start git upload-pack") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestGit_Cov_StreamGitRPCReportsBodyCopyError(t *testing.T) {
	installGitStub(t, "#!/bin/sh\ncat >/dev/null\nexit 0\n")

	err := streamGitRPC(context.Background(), t.TempDir(), "upload-pack", gitCovErrReader{}, io.Discard)
	if err == nil {
		t.Fatal("expected body copy error")
	}
	if !strings.Contains(err.Error(), "stream request body to git upload-pack") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestGit_Cov_StreamGitRPCReportsOutputWriteError(t *testing.T) {
	installGitStub(t, "#!/bin/sh\nprintf output\nexit 0\n")

	err := streamGitRPC(context.Background(), t.TempDir(), "upload-pack", nil, gitCovErrWriter{})
	if err == nil {
		t.Fatal("expected output write error")
	}
	if !strings.Contains(err.Error(), "stream git upload-pack output") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestGit_Cov_RunGitRPCBufferedSuccessAndFailure(t *testing.T) {
	installGitStub(t, "#!/bin/sh\nif [ \"$1\" = \"upload-pack\" ]; then printf buffered; exit 0; fi\nexit 9\n")

	got, err := runGitRPCBuffered(context.Background(), t.TempDir(), "upload-pack", nil)
	if err != nil {
		t.Fatalf("runGitRPCBuffered success returned error: %v", err)
	}
	if string(got) != "buffered" {
		t.Fatalf("buffered output = %q", got)
	}

	_, err = runGitRPCBuffered(context.Background(), t.TempDir(), "receive-pack", nil)
	if err == nil {
		t.Fatal("expected buffered git failure")
	}
}

func TestGit_Cov_ListGitRefsParsesRefsAndSkipsBlankLines(t *testing.T) {
	installGitStub(t, "#!/bin/sh\nprintf '\\nrefs/heads/main\\000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n\\nrefs/tags/v1\\000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n'\n")

	refs, err := listGitRefs(context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("listGitRefs returned error: %v", err)
	}
	if refs["refs/heads/main"] != "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" {
		t.Fatalf("main ref = %q", refs["refs/heads/main"])
	}
	if refs["refs/tags/v1"] != "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" {
		t.Fatalf("tag ref = %q", refs["refs/tags/v1"])
	}
}

func TestGit_Cov_ListGitRefsReportsGitFailure(t *testing.T) {
	installGitStub(t, "#!/bin/sh\nexit 12\n")

	_, err := listGitRefs(context.Background(), t.TempDir())
	if err == nil {
		t.Fatal("expected list refs git failure")
	}
	if !strings.Contains(err.Error(), "list git refs") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestGit_Cov_ListGitRefsRejectsMalformedLines(t *testing.T) {
	tests := []struct {
		name   string
		script string
	}{
		{name: "missing_separator", script: "#!/bin/sh\nprintf 'refs/heads/main\\n'\n"},
		{name: "empty_object", script: "#!/bin/sh\nprintf 'refs/heads/main\\000   \\n'\n"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			installGitStub(t, tt.script)

			_, err := listGitRefs(context.Background(), t.TempDir())
			if err == nil {
				t.Fatal("expected malformed ref listing error")
			}
			if !strings.Contains(err.Error(), "parse git ref listing") {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

// A repository with a pathological ref set must not make listGitRefs buffer
// an unbounded listing while the push holds the repository write lock: past
// the cap git is killed and the snapshot fails with a typed error.
func TestGit_Cov_ListGitRefsFailsClosedPastByteCap(t *testing.T) {
	oldMax := maxRefListingBytes
	maxRefListingBytes = 1024
	t.Cleanup(func() { maxRefListingBytes = oldMax })

	// An endless listing: only a killed subprocess ends it.
	installGitStub(t, "#!/bin/sh\nwhile :; do printf 'refs/heads/x\\000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n'; done\n")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	start := time.Now()
	_, err := listGitRefs(ctx, t.TempDir())
	if !errors.Is(err, errRefListingTooLarge) {
		t.Fatalf("listGitRefs error = %v, want errRefListingTooLarge", err)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("listGitRefs took %s; git was not killed at the cap", elapsed)
	}
}
