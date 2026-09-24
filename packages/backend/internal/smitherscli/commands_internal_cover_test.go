package smitherscli

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	incur "github.com/smithersai/incur"
)

func commandsInternalCovSetConfig(t *testing.T, apiURL string) {
	t.Helper()
	root := t.TempDir()
	configHome := filepath.Join(root, "config")
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("SMITHERS_AUTH_FILE", filepath.Join(root, "auth.json"))
	t.Setenv("SMITHERS_DISABLE_SYSTEM_KEYRING", "1")
	t.Setenv("SMITHERS_TOKEN", "commands_internal_cov_token")
	if err := os.MkdirAll(filepath.Join(configHome, "smithers"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configHome, "smithers", "config.toon"), []byte("api_url: "+apiURL+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func commandsInternalCovInstallFakeJj(t *testing.T) string {
	t.Helper()
	binDir := filepath.Join(t.TempDir(), "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'jj 0.99.0\n'
  exit 0
fi
if [ "$1" = "--ignore-working-copy" ]; then
  shift
fi
if [ "$1" = "bookmark" ] && [ "$2" = "list" ]; then
  printf 'main\tparent1\tcommit-parent\nfeature\twc123\tcommit-wc\n'
  exit 0
fi
if [ "$1" = "log" ] && [ "$2" = "-r" ]; then
  case "$3" in
    @) printf 'wc123\tcommit-wc\tWorking change\n' ;;
    @-) printf 'parent1\tcommit-parent\tParent change\n' ;;
    *) printf '%s\tcommit-%s\tRevision %s\n' "$3" "$3" "$3" ;;
  esac
  exit 0
fi
if [ "$1" = "diff" ] && [ "$2" = "--summary" ]; then
  printf 'M file.go\n'
  exit 0
fi
printf 'unexpected jj args: %s\n' "$*" >&2
exit 1
`
	if err := os.WriteFile(filepath.Join(binDir, "jj"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return binDir
}

func TestCommandsInternal_Cov_StatePathsSchedulesAndLocks(t *testing.T) {
	configHome := filepath.Join(t.TempDir(), "config")
	t.Setenv("XDG_CONFIG_HOME", configHome)

	cwd := mustGetwd()
	if cwd == "" {
		t.Fatal("mustGetwd returned empty cwd")
	}
	root := smithersPushStateRoot()
	if root != filepath.Join(configHome, "smithers") {
		t.Fatalf("smithersPushStateRoot = %q", root)
	}
	if dir := pushStateDir(); !strings.HasSuffix(dir, filepath.Join("smithers", "push-state")) {
		t.Fatalf("pushStateDir = %q", dir)
	}
	appendPushLog("coverage log entry")
	logBytes, err := os.ReadFile(pushLogPath())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(logBytes), "coverage log entry") {
		t.Fatalf("push log missing entry:\n%s", string(logBytes))
	}

	sum := sha256.Sum256([]byte("/tmp/repo"))
	if got, want := pushRepoKey("/tmp/repo"), hex.EncodeToString(sum[:])[:24]; got != want {
		t.Fatalf("pushRepoKey = %q, want %q", got, want)
	}
	if !strings.HasSuffix(schedulePathForRepo("abc"), filepath.Join("push-state", "abc.json")) {
		t.Fatalf("schedulePathForRepo = %q", schedulePathForRepo("abc"))
	}
	if !strings.HasSuffix(lockPathForRepo("abc"), filepath.Join("push-state", "abc.lock")) {
		t.Fatalf("lockPathForRepo = %q", lockPathForRepo("abc"))
	}
	if urlPath("owner name/repo") != "owner%20name%2Frepo" {
		t.Fatalf("urlPath returned %q", urlPath("owner name/repo"))
	}

	missingParentSchedule := filepath.Join(t.TempDir(), "missing", "repo.json")
	if err := writeScheduleState(missingParentSchedule, pushScheduleState{CWD: cwd, DueAtMS: 1, Sequence: 1}); err == nil {
		t.Fatal("writeScheduleState succeeded without parent directory")
	}
	schedulePath := schedulePathForRepo("state-roundtrip")
	state := pushScheduleState{CWD: cwd, DueAtMS: time.Now().UnixMilli(), Sequence: 3}
	if err := writeScheduleState(schedulePath, state); err != nil {
		t.Fatalf("writeScheduleState returned error: %v", err)
	}
	if got := parseScheduleState(schedulePath); got == nil || *got != state {
		t.Fatalf("parseScheduleState = %#v, want %#v", got, state)
	}
	for _, raw := range []string{`not-json`, `{"cwd":"","due_at_ms":1}`, `{"cwd":"repo","due_at_ms":0}`} {
		if err := os.WriteFile(schedulePath, []byte(raw), 0o644); err != nil {
			t.Fatal(err)
		}
		if got := parseScheduleState(schedulePath); got != nil {
			t.Fatalf("parseScheduleState(%s) = %#v", raw, got)
		}
	}
	if got := parseScheduleState(filepath.Join(t.TempDir(), "missing.json")); got != nil {
		t.Fatalf("parseScheduleState missing = %#v", got)
	}

	if processIsAlive(0) || !processIsAlive(os.Getpid()) {
		t.Fatal("processIsAlive returned unexpected result for pid 0/current pid")
	}
	lockPath := lockPathForRepo("lock-roundtrip")
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := parseWorkerLockState(filepath.Join(t.TempDir(), "missing.lock")); got != nil {
		t.Fatalf("parseWorkerLockState missing = %#v", got)
	}
	if err := os.WriteFile(lockPath, []byte("\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := parseWorkerLockState(lockPath); got != nil {
		t.Fatalf("parseWorkerLockState blank = %#v", got)
	}
	if err := os.WriteFile(lockPath, []byte("12345\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := parseWorkerLockState(lockPath); got == nil || got.PID != 12345 || got.CreatedAtMS == 0 {
		t.Fatalf("parseWorkerLockState legacy = %#v", got)
	}
	active := workerLockState{PID: os.Getpid(), CreatedAtMS: time.Now().UnixMilli()}
	rawActive, _ := json.Marshal(active)
	if err := os.WriteFile(lockPath, append(rawActive, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := parseWorkerLockState(lockPath); got == nil || *got != active {
		t.Fatalf("parseWorkerLockState json = %#v", got)
	}
	if isStaleWorkerLock(lockPath) {
		t.Fatal("active fresh lock reported stale")
	}
	old := workerLockState{PID: os.Getpid(), CreatedAtMS: time.Now().Add(-pushLockStale - time.Second).UnixMilli()}
	rawOld, _ := json.Marshal(old)
	if err := os.WriteFile(lockPath, append(rawOld, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	if !isStaleWorkerLock(lockPath) {
		t.Fatal("old lock was not stale")
	}
	if !isStaleWorkerLock(filepath.Join(t.TempDir(), "missing.lock")) {
		t.Fatal("missing lock should be stale")
	}

	badLockPath := filepath.Join(t.TempDir(), "missing", "repo.lock")
	if acquired, err := tryAcquireWorkerLock(badLockPath); err == nil || acquired {
		t.Fatalf("tryAcquireWorkerLock missing parent = (%t, %v)", acquired, err)
	}
	freshLockPath := filepath.Join(t.TempDir(), "repo.lock")
	acquired, err := tryAcquireWorkerLock(freshLockPath)
	if err != nil || !acquired {
		t.Fatalf("tryAcquireWorkerLock fresh = (%t, %v)", acquired, err)
	}
	acquired, err = tryAcquireWorkerLock(freshLockPath)
	if err != nil || acquired {
		t.Fatalf("tryAcquireWorkerLock existing = (%t, %v)", acquired, err)
	}
	releaseWorkerLock(freshLockPath)
	if _, err := os.Stat(freshLockPath); !os.IsNotExist(err) {
		t.Fatalf("releaseWorkerLock did not remove lock: %v", err)
	}

	staleLockPath := filepath.Join(t.TempDir(), "stale.lock")
	rawDead, _ := json.Marshal(workerLockState{PID: 999999999, CreatedAtMS: time.Now().UnixMilli()})
	if err := os.WriteFile(staleLockPath, append(rawDead, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	acquired, err = acquireWorkerLock(staleLockPath)
	if err != nil || !acquired {
		t.Fatalf("acquireWorkerLock stale = (%t, %v)", acquired, err)
	}
	releaseWorkerLock(staleLockPath)
	activeLockPath := filepath.Join(t.TempDir(), "active.lock")
	rawActive, _ = json.Marshal(active)
	if err := os.WriteFile(activeLockPath, append(rawActive, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	acquired, err = acquireWorkerLock(activeLockPath)
	if err != nil || acquired {
		t.Fatalf("acquireWorkerLock active = (%t, %v)", acquired, err)
	}

	queueCWD := filepath.Join(t.TempDir(), "repo")
	if err := os.MkdirAll(queueCWD, 0o755); err != nil {
		t.Fatal(err)
	}
	queueKey := pushRepoKey(queueCWD)
	queueLock := lockPathForRepo(queueKey)
	if err := os.MkdirAll(filepath.Dir(queueLock), 0o755); err != nil {
		t.Fatal(err)
	}
	rawActive, _ = json.Marshal(active)
	if err := os.WriteFile(queueLock, append(rawActive, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := queuePushWorker(queueCWD); err != nil {
		t.Fatalf("queuePushWorker active lock returned error: %v", err)
	}
	if err := queuePushWorker(queueCWD); err != nil {
		t.Fatalf("queuePushWorker second active lock returned error: %v", err)
	}
	queued := parseScheduleState(schedulePathForRepo(queueKey))
	if queued == nil || queued.CWD != queueCWD || queued.Sequence != 2 || queued.DueAtMS == 0 {
		t.Fatalf("queued schedule = %#v", queued)
	}
	if _, err := spawnDetachedWorker("repo-key", filepath.Join(t.TempDir(), "does-not-exist")); err == nil {
		t.Fatal("spawnDetachedWorker succeeded with invalid cwd")
	}
}

func TestCommandsInternal_Cov_PushRepoStateWorkerAndCommand(t *testing.T) {
	commandsInternalCovInstallFakeJj(t)
	var syncBodies []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "token commands_internal_cov_token" {
			t.Fatalf("Authorization = %q", got)
		}
		if r.Method != http.MethodPost || r.URL.Path != "/api/repos/alice/demo/sync" {
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.RequestURI())
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("invalid sync body: %v", err)
		}
		syncBodies = append(syncBodies, body)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"ok":true}`)
	}))
	defer server.Close()
	commandsInternalCovSetConfig(t, server.URL)

	noConnectionDir := t.TempDir()
	if got := readLocalRepoConnection(noConnectionDir); got != nil {
		t.Fatalf("readLocalRepoConnection empty = %#v", got)
	}
	if err := pushRepoState(noConnectionDir); err != nil {
		t.Fatalf("pushRepoState without connection returned error: %v", err)
	}
	badConfigDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(badConfigDir, ".smithers", "config.json"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := readLocalRepoConnection(badConfigDir); got != nil {
		t.Fatalf("readLocalRepoConnection invalid file = %#v", got)
	}

	repoDir := t.TempDir()
	if err := saveLocalRepoConnection(repoDir, localRepoConnection{ConnectedAt: time.Now().Format(time.RFC3339), LicenseSPDXID: "MIT", Repo: "not-a-repo"}); err != nil {
		t.Fatal(err)
	}
	if err := pushRepoState(repoDir); err == nil || !strings.Contains(err.Error(), "OWNER/REPO") {
		t.Fatalf("pushRepoState invalid repo error = %v", err)
	}
	if err := saveLocalRepoConnection(repoDir, localRepoConnection{ConnectedAt: time.Now().Format(time.RFC3339), LicenseSPDXID: "MIT", Repo: "alice/demo"}); err != nil {
		t.Fatal(err)
	}
	connection := readLocalRepoConnection(repoDir)
	if connection == nil || connection.Repo != "alice/demo" {
		t.Fatalf("readLocalRepoConnection valid = %#v", connection)
	}
	if err := pushRepoState(repoDir); err != nil {
		t.Fatalf("pushRepoState valid returned error: %v", err)
	}
	if len(syncBodies) != 1 {
		t.Fatalf("sync request count = %d", len(syncBodies))
	}
	body := syncBodies[0]
	if len(arrayValue(body["bookmarks"])) != 2 {
		t.Fatalf("sync bookmarks = %#v", body["bookmarks"])
	}
	parent := objectValue(body["working_copy_parent"])
	if parent["change_id"] != "parent1" || parent["commit_id"] != "commit-parent" {
		t.Fatalf("sync parent = %#v", parent)
	}

	workerKey := "commands-internal-cov-worker"
	workerSchedule := schedulePathForRepo(workerKey)
	if err := os.MkdirAll(filepath.Dir(workerSchedule), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := writeScheduleState(workerSchedule, pushScheduleState{CWD: noConnectionDir, DueAtMS: time.Now().Add(-time.Millisecond).UnixMilli(), Sequence: 1}); err != nil {
		t.Fatal(err)
	}
	workerLock := lockPathForRepo(workerKey)
	if err := os.WriteFile(workerLock, []byte(`{"created_at_ms":1,"pid":1}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := runPushWorker(workerKey, repoDir); err != nil {
		t.Fatalf("runPushWorker returned error: %v", err)
	}
	if _, err := os.Stat(workerSchedule); !os.IsNotExist(err) {
		t.Fatalf("runPushWorker did not remove completed schedule: %v", err)
	}
	if _, err := os.Stat(workerLock); !os.IsNotExist(err) {
		t.Fatalf("runPushWorker did not release lock: %v", err)
	}

	var stdout bytes.Buffer
	err := internalCommand().ServeWithOptions([]string{"push-to-smithers", "--worker", "--repo-key", "empty-worker", "--repo-cwd", noConnectionDir}, incur.ServeOptions{Stdout: &stdout})
	if err != nil {
		t.Fatalf("internalCommand worker returned error: %v stdout=%s", err, stdout.String())
	}
	stdout.Reset()
	if err := internalCommand().ServeWithOptions([]string{"--help"}, incur.ServeOptions{Stdout: &stdout}); err != nil {
		t.Fatalf("internalCommand help returned error: %v", err)
	}
	if !strings.Contains(stdout.String(), "push-to-smithers") {
		t.Fatalf("internalCommand help missing subcommand:\n%s", stdout.String())
	}
}
