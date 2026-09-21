package smitherscli

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	incur "github.com/smithersai/incur"
)

func internalFSetXDG(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", home)
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	return home
}

func internalFServe(t *testing.T, argv ...string) error {
	t.Helper()
	var stdout bytes.Buffer
	return internalCommand().ServeWithOptions(argv, incur.ServeOptions{Stdout: &stdout})
}

func TestCommandsInternal_F_HandlerNonWorkerSpawnSuccess(t *testing.T) {
	internalFSetXDG(t)
	oldSpawn := internalSpawnWorker
	internalSpawnWorker = func(string, string) error { return nil }
	t.Cleanup(func() { internalSpawnWorker = oldSpawn })
	if err := internalFServe(t, "push-to-smithers"); err != nil {
		t.Fatalf("handler non-worker spawn success = %v", err)
	}
}

func TestCommandsInternal_F_HandlerNonWorkerSpawnError(t *testing.T) {
	internalFSetXDG(t)
	oldSpawn := internalSpawnWorker
	internalSpawnWorker = func(string, string) error { return errors.New("spawn boom") }
	t.Cleanup(func() { internalSpawnWorker = oldSpawn })
	// queuePushWorker returns the spawn error, which the handler logs.
	if err := internalFServe(t, "push-to-smithers"); err != nil {
		t.Fatalf("handler non-worker spawn error return = %v", err)
	}
}

func TestCommandsInternal_F_HandlerWorkerDefaultsAndError(t *testing.T) {
	internalFSetXDG(t)
	oldParse := internalParseSchedule
	oldPush := internalPushRepoState
	internalParseSchedule = func(string) *pushScheduleState {
		return &pushScheduleState{CWD: "x", DueAtMS: time.Now().Add(-time.Second).UnixMilli(), Sequence: 1}
	}
	internalPushRepoState = func(string) error { return errors.New("push boom") }
	t.Cleanup(func() {
		internalParseSchedule = oldParse
		internalPushRepoState = oldPush
	})
	// --worker without repo-cwd/repo-key exercises the mustGetwd/pushRepoKey defaults;
	// runPushWorker then errors and the handler logs it.
	if err := internalFServe(t, "push-to-smithers", "--worker"); err != nil {
		t.Fatalf("handler worker defaults = %v", err)
	}
}

func TestCommandsInternal_F_MustGetwdError(t *testing.T) {
	old := internalGetwd
	internalGetwd = func() (string, error) { return "", errors.New("getwd boom") }
	t.Cleanup(func() { internalGetwd = old })
	if got := mustGetwd(); got != "." {
		t.Fatalf("mustGetwd getwd error = %q", got)
	}
}

func TestCommandsInternal_F_AppendPushLogOpenError(t *testing.T) {
	home := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", home)
	// Make the smithers dir a regular file so push.log cannot be opened.
	if err := os.WriteFile(filepath.Join(home, "smithers"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	appendPushLog("should be swallowed") // must not panic
}

func TestCommandsInternal_F_WriteScheduleMarshalError(t *testing.T) {
	old := internalScheduleMarshal
	internalScheduleMarshal = func(any) ([]byte, error) { return nil, errors.New("marshal boom") }
	t.Cleanup(func() { internalScheduleMarshal = old })
	if err := writeScheduleState(filepath.Join(t.TempDir(), "s.json"), pushScheduleState{CWD: "x", DueAtMS: 1, Sequence: 1}); err == nil {
		t.Fatal("writeScheduleState marshal error expected")
	}
}

func TestCommandsInternal_F_ProcessIsAliveSeams(t *testing.T) {
	oldFind := internalFindProcess
	internalFindProcess = func(int) (*os.Process, error) { return nil, errors.New("find boom") }
	if processIsAlive(4242) {
		t.Fatal("processIsAlive should be false on FindProcess error")
	}
	internalFindProcess = oldFind

	oldGOOS := cliGOOS
	cliGOOS = "windows"
	t.Cleanup(func() { cliGOOS = oldGOOS })
	if !processIsAlive(os.Getpid()) {
		t.Fatal("processIsAlive windows should return true")
	}
}

func TestCommandsInternal_F_ParseWorkerLockZeroPID(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "z.lock")
	if err := os.WriteFile(lockPath, []byte(`{"created_at_ms":5}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := parseWorkerLockState(lockPath); got != nil {
		t.Fatalf("parseWorkerLockState zero pid = %#v", got)
	}
}

func TestCommandsInternal_F_AcquireFreshLock(t *testing.T) {
	lockPath := filepath.Join(t.TempDir(), "fresh.lock")
	acquired, err := acquireWorkerLock(lockPath)
	if err != nil || !acquired {
		t.Fatalf("acquireWorkerLock fresh = (%t, %v)", acquired, err)
	}
}

func TestCommandsInternal_F_QueuePushWriteError(t *testing.T) {
	internalFSetXDG(t)
	old := internalScheduleMarshal
	internalScheduleMarshal = func(any) ([]byte, error) { return nil, errors.New("marshal boom") }
	t.Cleanup(func() { internalScheduleMarshal = old })
	if err := queuePushWorker(t.TempDir()); err == nil {
		t.Fatal("queuePushWorker writeScheduleState error expected")
	}
}

func TestCommandsInternal_F_PushRepoStateJjErrors(t *testing.T) {
	jjFInstall(t)
	dir := t.TempDir()
	if err := saveLocalRepoConnection(dir, localRepoConnection{
		ConnectedAt:   time.Now().Format(time.RFC3339),
		LicenseSPDXID: "MIT",
		Repo:          "alice/demo",
	}); err != nil {
		t.Fatal(err)
	}

	// bookmark listing fails
	t.Setenv("JJF_FAIL", "bookmark list")
	if err := pushRepoState(dir); err == nil {
		t.Fatal("pushRepoState bookmarks error expected")
	}
	os.Unsetenv("JJF_FAIL")

	// status (log -r) fails, bookmarks succeed
	t.Setenv("JJF_FAIL", "log -r")
	if err := pushRepoState(dir); err == nil {
		t.Fatal("pushRepoState status error expected")
	}
}

func internalFSchedule(due time.Duration, seq int) *pushScheduleState {
	return &pushScheduleState{CWD: "x", DueAtMS: time.Now().Add(due).UnixMilli(), Sequence: seq}
}

func TestCommandsInternal_F_RunPushWorkerBranches(t *testing.T) {
	internalFSetXDG(t)
	oldParse := internalParseSchedule
	oldPush := internalPushRepoState
	t.Cleanup(func() {
		internalParseSchedule = oldParse
		internalPushRepoState = oldPush
	})

	drive := func(states []*pushScheduleState, push func(string) error) error {
		i := 0
		internalParseSchedule = func(string) *pushScheduleState {
			if i >= len(states) {
				return nil
			}
			s := states[i]
			i++
			return s
		}
		internalPushRepoState = push
		return runPushWorker("branch-key", "/fallback")
	}

	// queued nil immediately
	if err := drive([]*pushScheduleState{nil}, func(string) error { return nil }); err != nil {
		t.Fatalf("queued nil = %v", err)
	}
	// wait>0 then ready nil
	if err := drive([]*pushScheduleState{internalFSchedule(20*time.Millisecond, 1), nil}, func(string) error { return nil }); err != nil {
		t.Fatalf("wait then ready nil = %v", err)
	}
	// ready DueAtMS in future -> continue, then queued nil
	if err := drive([]*pushScheduleState{internalFSchedule(-time.Second, 1), internalFSchedule(time.Hour, 1), nil}, func(string) error { return nil }); err != nil {
		t.Fatalf("ready future continue = %v", err)
	}
	// pushRepoState error
	if err := drive([]*pushScheduleState{internalFSchedule(-time.Second, 1), internalFSchedule(-time.Second, 1)}, func(string) error { return errors.New("push boom") }); err == nil {
		t.Fatal("pushRepoState error expected")
	}
	// after nil after push
	if err := drive([]*pushScheduleState{internalFSchedule(-time.Second, 1), internalFSchedule(-time.Second, 1), nil}, func(string) error { return nil }); err != nil {
		t.Fatalf("after nil = %v", err)
	}
	// after sequence differs -> loop, then queued nil
	states := []*pushScheduleState{internalFSchedule(-time.Second, 1), internalFSchedule(-time.Second, 1), internalFSchedule(-time.Second, 2), nil}
	if err := drive(states, func(string) error { return nil }); err != nil {
		t.Fatalf("after sequence differs = %v", err)
	}
}
