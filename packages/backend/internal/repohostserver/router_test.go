package repohostserver

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRemoveEmptyOwnerDirRemovesEmptyDirectory(t *testing.T) {
	root := t.TempDir()
	ownerDir := filepath.Join(root, "alice")
	if err := os.MkdirAll(ownerDir, 0o755); err != nil {
		t.Fatalf("mkdir owner dir: %v", err)
	}

	if err := removeEmptyOwnerDir(ownerDir); err != nil {
		t.Fatalf("removeEmptyOwnerDir: %v", err)
	}

	if _, err := os.Stat(ownerDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected owner dir to be removed, stat err=%v", err)
	}
}

func TestRemoveEmptyOwnerDirKeepsNonEmptyDirectory(t *testing.T) {
	root := t.TempDir()
	ownerDir := filepath.Join(root, "alice")
	if err := os.MkdirAll(ownerDir, 0o755); err != nil {
		t.Fatalf("mkdir owner dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(ownerDir, "repo"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write repo marker: %v", err)
	}

	if err := removeEmptyOwnerDir(ownerDir); err != nil {
		t.Fatalf("removeEmptyOwnerDir: %v", err)
	}

	if _, err := os.Stat(ownerDir); err != nil {
		t.Fatalf("expected owner dir to remain, stat err=%v", err)
	}
}

func TestServerShutdownWaitsForBackgroundWork(t *testing.T) {
	var s Server
	s.background.Add(1)
	go func() {
		time.Sleep(25 * time.Millisecond)
		s.background.Done()
	}()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	start := time.Now()
	if err := s.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	if time.Since(start) < 25*time.Millisecond {
		t.Fatal("Shutdown returned before background work completed")
	}
}

func TestServerShutdownHonorsContextDeadline(t *testing.T) {
	var s Server
	s.background.Add(1)
	defer s.background.Done()

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	if err := s.Shutdown(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected deadline exceeded, got %v", err)
	}
}
