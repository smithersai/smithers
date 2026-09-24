package ssh

import (
	"testing"
	"time"
)

// The upload-pack (clone/fetch) response timeout must be configurable and
// generous. A hardcoded 60s cap truncated large or slow clones; the default now
// mirrors receive-pack (10m).
func TestUploadPackTimeoutDefaultAndOverride(t *testing.T) {
	s := &Server{}
	if got := s.uploadPackTimeout(); got != defaultUploadPackTimeout {
		t.Fatalf("default upload-pack timeout = %v, want %v", got, defaultUploadPackTimeout)
	}
	if defaultUploadPackTimeout < 5*time.Minute {
		t.Fatalf("default upload-pack timeout %v is too short to stream large clones", defaultUploadPackTimeout)
	}

	s.UploadPackTimeout = 3 * time.Minute
	if got := s.uploadPackTimeout(); got != 3*time.Minute {
		t.Fatalf("override upload-pack timeout = %v, want 3m", got)
	}
}
