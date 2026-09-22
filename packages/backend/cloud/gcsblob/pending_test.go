package gcsblob

import (
	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"testing"
)

func TestPendingUploadKey(t *testing.T) {
	t.Parallel()

	got := blob.PendingUploadKey("release-assets", "/repos/7/releases/9/assets/11/app.tgz")
	want := "pending/release-assets/repos/7/releases/9/assets/11/app.tgz"
	if got != want {
		t.Fatalf("blob.PendingUploadKey() = %q, want %q", got, want)
	}
}

func TestGenerationPurgeKeyIncludesPendingNamespaces(t *testing.T) {
	t.Parallel()

	for _, key := range []string{
		"pending/workflow-artifacts/repos/1/runs/2/artifacts/3/out.tgz",
		"lfs-pending/1/abc",
		"repos/1/lfs/abc",
		"repos/1/releases/2/assets/3/app.tgz",
	} {
		if !isGenerationPurgeKey(key) {
			t.Fatalf("isGenerationPurgeKey(%q) = false, want true", key)
		}
	}
	if isGenerationPurgeKey("repos/1/runs/2/artifacts/3/app.tgz") {
		t.Fatal("unclassified final objects must retain normal versioned-delete behavior")
	}
}
