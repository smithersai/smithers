//go:build linux

package smitherscli

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPushRepoKeyUsesStableSHA256Prefix(t *testing.T) {
	cwd := "/tmp/smithers/repo"
	sum := sha256.Sum256([]byte(cwd))
	expected := hex.EncodeToString(sum[:])[:24]

	if got := pushRepoKey(cwd); got != expected {
		t.Fatalf("pushRepoKey(%q) = %q, want %q", cwd, got, expected)
	}
}

func TestScheduleStateRoundTripAndValidation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "push-state", "repo.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}

	state := pushScheduleState{
		CWD:      "/tmp/repo",
		DueAtMS:  time.Now().UnixMilli(),
		Sequence: 7,
	}
	if err := writeScheduleState(path, state); err != nil {
		t.Fatalf("writeScheduleState returned error: %v", err)
	}

	got := parseScheduleState(path)
	if got == nil {
		t.Fatal("parseScheduleState returned nil")
	}
	if *got != state {
		t.Fatalf("parsed schedule = %#v, want %#v", *got, state)
	}

	if err := os.WriteFile(path, []byte(`{"cwd":"","due_at_ms":1,"sequence":1}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := parseScheduleState(path); got != nil {
		t.Fatalf("invalid schedule should parse as nil, got %#v", got)
	}
}

func TestWorkerLockRecoversFromStalePID(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "push-state", "repo.lock")
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		t.Fatal(err)
	}
	stale := workerLockState{
		CreatedAtMS: time.Now().UnixMilli(),
		PID:         999999999,
	}
	raw, err := json.Marshal(stale)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(lockPath, append(raw, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}

	acquired, err := acquireWorkerLock(lockPath)
	if err != nil {
		t.Fatalf("acquireWorkerLock returned error: %v", err)
	}
	if !acquired {
		t.Fatal("expected stale lock to be acquired")
	}

	after := parseWorkerLockState(lockPath)
	if after == nil {
		t.Fatal("replacement lock was not parseable")
	}
	if after.PID == stale.PID {
		t.Fatalf("lock PID was not replaced: %#v", after)
	}
	releaseWorkerLock(lockPath)
	if _, err := os.Stat(lockPath); !os.IsNotExist(err) {
		t.Fatalf("releaseWorkerLock did not remove lock, stat err: %v", err)
	}
}

func TestWorkerLockDoesNotReplaceActiveLock(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "push-state", "repo.lock")
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		t.Fatal(err)
	}
	active := workerLockState{
		CreatedAtMS: time.Now().UnixMilli(),
		PID:         os.Getpid(),
	}
	raw, err := json.Marshal(active)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(lockPath, append(raw, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}

	acquired, err := acquireWorkerLock(lockPath)
	if err != nil {
		t.Fatalf("acquireWorkerLock returned error: %v", err)
	}
	if acquired {
		t.Fatal("expected active lock not to be acquired")
	}

	after := parseWorkerLockState(lockPath)
	if after == nil || *after != active {
		t.Fatalf("active lock was replaced: %#v", after)
	}
}

func TestParseWorkerLockStateSupportsLegacyPIDFile(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "repo.lock")
	if err := os.WriteFile(lockPath, []byte("12345\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	got := parseWorkerLockState(lockPath)
	if got == nil {
		t.Fatal("legacy PID lock parsed as nil")
	}
	if got.PID != 12345 {
		t.Fatalf("legacy lock PID = %d, want 12345", got.PID)
	}
	if got.CreatedAtMS == 0 {
		t.Fatalf("legacy lock CreatedAtMS should be populated: %#v", got)
	}
}

func TestRunPushWorkerReleasesLockWhenNoScheduleExists(t *testing.T) {
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)

	repoKey := "repo-without-schedule"
	lockPath := lockPathForRepo(repoKey)
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(lockPath, []byte(`{"created_at_ms":1,"pid":1}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := runPushWorker(repoKey, t.TempDir()); err != nil {
		t.Fatalf("runPushWorker returned error: %v", err)
	}
	if _, err := os.Stat(lockPath); !os.IsNotExist(err) {
		t.Fatalf("runPushWorker did not release lock, stat err: %v", err)
	}
}
