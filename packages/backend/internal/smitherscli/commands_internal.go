package smitherscli

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	incur "github.com/smithersai/incur"
)

const pushDebounce = 500 * time.Millisecond
const pushLogFilename = "push.log"
const pushLockStale = 5 * time.Minute

// Seams so tests can exercise platform-specific, process-spawning, and
// otherwise-defensive branches deterministically.
var (
	internalFindProcess     = os.FindProcess
	internalScheduleMarshal = json.Marshal
	internalSpawnWorker     = spawnDetachedWorker
	internalParseSchedule   = parseScheduleState
	internalPushRepoState   = pushRepoState
	internalGetwd           = os.Getwd
)

type pushScheduleState struct {
	CWD      string `json:"cwd"`
	DueAtMS  int64  `json:"due_at_ms"`
	Sequence int    `json:"sequence"`
}

type workerLockState struct {
	CreatedAtMS int64 `json:"created_at_ms"`
	PID         int   `json:"pid"`
}

func internalCommand() *incur.Cli {
	cmd := incur.New("_internal")
	cmd.Command("push-to-smithers", &incur.CommandDef{
		OptionsSchema: objectSchema(nil, map[string]*incur.JSONSchema{
			"repo-cwd": stringSchema("Repository cwd"),
			"repo-key": stringSchema("Repository key"),
			"worker":   booleanSchema("Run as worker", false),
		}),
		Handler: func(ctx *incur.CommandContext) (any, error) {
			if ctx.Options["worker"] != true {
				if err := queuePushWorker(mustGetwd()); err != nil {
					appendPushLog(err.Error())
				}
				return nil, nil
			}
			repoCWD := stringValue(ctx.Options["repo-cwd"])
			if repoCWD == "" {
				repoCWD = mustGetwd()
			}
			repoKey := stringValue(ctx.Options["repo-key"])
			if repoKey == "" {
				repoKey = pushRepoKey(repoCWD)
			}
			if err := runPushWorker(repoKey, repoCWD); err != nil {
				appendPushLog(err.Error())
			}
			return nil, nil
		},
	})
	return cmd
}

func mustGetwd() string {
	cwd, err := internalGetwd()
	if err != nil {
		return "."
	}
	return cwd
}

func smithersPushStateRoot() string {
	dir := filepath.Dir(ConfigPath())
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

func pushLogPath() string {
	return filepath.Join(smithersPushStateRoot(), pushLogFilename)
}

func pushStateDir() string {
	dir := filepath.Join(smithersPushStateRoot(), "push-state")
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

func pushRepoKey(cwd string) string {
	sum := sha256.Sum256([]byte(cwd))
	return hex.EncodeToString(sum[:])[:24]
}

func schedulePathForRepo(repoKey string) string {
	return filepath.Join(pushStateDir(), repoKey+".json")
}

func lockPathForRepo(repoKey string) string {
	return filepath.Join(pushStateDir(), repoKey+".lock")
}

func appendPushLog(message string) {
	file, err := os.OpenFile(pushLogPath(), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer func() { _ = file.Close() }()
	_, _ = fmt.Fprintf(file, "%s %s\n", time.Now().UTC().Format(time.RFC3339Nano), message)
}

func readLocalRepoConnection(cwd string) *localRepoConnection {
	connection, err := localRepoConnectionFor(cwd)
	if err != nil {
		return nil
	}
	return connection
}

func parseScheduleState(path string) *pushScheduleState {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var state pushScheduleState
	if err := json.Unmarshal(raw, &state); err != nil || state.CWD == "" || state.DueAtMS == 0 {
		return nil
	}
	return &state
}

func writeScheduleState(path string, state pushScheduleState) error {
	temp := fmt.Sprintf("%s.%d.tmp", path, os.Getpid())
	raw, err := internalScheduleMarshal(state)
	if err != nil {
		return err
	}
	if err := os.WriteFile(temp, append(raw, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(temp, path)
}

func processIsAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	process, err := internalFindProcess(pid)
	if err != nil {
		return false
	}
	if cliGOOS == "windows" {
		return true
	}
	err = process.Signal(syscall.Signal(0))
	return err == nil || strings.Contains(err.Error(), "operation not permitted")
}

func parseWorkerLockState(lockPath string) *workerLockState {
	raw, err := os.ReadFile(lockPath)
	if err != nil {
		return nil
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return nil
	}
	if pid, err := strconv.Atoi(trimmed); err == nil {
		info, _ := os.Stat(lockPath)
		created := time.Now()
		if info != nil {
			created = info.ModTime()
		}
		return &workerLockState{CreatedAtMS: created.UnixMilli(), PID: pid}
	}
	var state workerLockState
	if err := json.Unmarshal([]byte(trimmed), &state); err != nil || state.PID == 0 || state.CreatedAtMS == 0 {
		return nil
	}
	return &state
}

func isStaleWorkerLock(lockPath string) bool {
	lock := parseWorkerLockState(lockPath)
	if lock == nil {
		return true
	}
	if !processIsAlive(lock.PID) {
		return true
	}
	return time.Since(time.UnixMilli(lock.CreatedAtMS)) > pushLockStale
}

func tryAcquireWorkerLock(lockPath string) (bool, error) {
	file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		if os.IsExist(err) {
			return false, nil
		}
		return false, err
	}
	defer func() { _ = file.Close() }()
	raw, _ := json.Marshal(workerLockState{CreatedAtMS: time.Now().UnixMilli(), PID: os.Getpid()})
	_, err = file.Write(append(raw, '\n'))
	return err == nil, err
}

func acquireWorkerLock(lockPath string) (bool, error) {
	acquired, err := tryAcquireWorkerLock(lockPath)
	if err != nil || acquired {
		return acquired, err
	}
	if !isStaleWorkerLock(lockPath) {
		return false, nil
	}
	_ = os.Remove(lockPath)
	return tryAcquireWorkerLock(lockPath)
}

func releaseWorkerLock(lockPath string) {
	_ = os.Remove(lockPath)
}

func spawnDetachedWorker(repoKey, repoCWD string) error {
	args := []string{"_internal", "push-to-smithers", "--worker", "--repo-key", repoKey, "--repo-cwd", repoCWD}
	cmd := exec.Command(os.Args[0], args...)
	cmd.Dir = repoCWD
	cmd.Env = os.Environ()
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	return cmd.Start()
}

func pushRepoState(cwd string) error {
	localConnection := readLocalRepoConnection(cwd)
	if localConnection == nil {
		return nil
	}
	owner, repo, err := parseOwnerRepoRefOrThrow(localConnection.Repo)
	if err != nil {
		return err
	}
	oldwd, _ := os.Getwd()
	_ = os.Chdir(cwd)
	defer func() { _ = os.Chdir(oldwd) }()
	bookmarks, err := ListLocalBookmarks(nil, LocalReadOptions{IgnoreWorkingCopy: true})
	if err != nil {
		return err
	}
	status, err := GetLocalStatus(LocalReadOptions{IgnoreWorkingCopy: true})
	if err != nil {
		return err
	}
	_, err = APIRequest("POST", fmt.Sprintf("/api/repos/%s/%s/sync", urlPath(owner), urlPath(repo)), map[string]any{
		"bookmarks": bookmarks,
		"working_copy_parent": map[string]any{
			"change_id": status.Parent.ChangeID,
			"commit_id": status.Parent.CommitID,
		},
	}, nil)
	return err
}

func queuePushWorker(cwd string) error {
	repoKey := pushRepoKey(cwd)
	schedulePath := schedulePathForRepo(repoKey)
	previous := parseScheduleState(schedulePath)
	sequence := 1
	if previous != nil {
		sequence = previous.Sequence + 1
	}
	if err := writeScheduleState(schedulePath, pushScheduleState{CWD: cwd, DueAtMS: time.Now().Add(pushDebounce).UnixMilli(), Sequence: sequence}); err != nil {
		return err
	}
	lockPath := lockPathForRepo(repoKey)
	acquired, err := acquireWorkerLock(lockPath)
	if err != nil || !acquired {
		return err
	}
	if err := internalSpawnWorker(repoKey, cwd); err != nil {
		releaseWorkerLock(lockPath)
		return err
	}
	return nil
}

func runPushWorker(repoKey, fallbackCWD string) error {
	schedulePath := schedulePathForRepo(repoKey)
	lockPath := lockPathForRepo(repoKey)
	defer releaseWorkerLock(lockPath)
	for {
		queued := internalParseSchedule(schedulePath)
		if queued == nil {
			return nil
		}
		wait := time.Until(time.UnixMilli(queued.DueAtMS))
		if wait > 0 {
			time.Sleep(wait)
		}
		ready := internalParseSchedule(schedulePath)
		if ready == nil {
			return nil
		}
		if ready.DueAtMS > time.Now().UnixMilli() {
			continue
		}
		// parseScheduleState guarantees a non-empty CWD.
		cwd := ready.CWD
		if err := internalPushRepoState(cwd); err != nil {
			return err
		}
		after := internalParseSchedule(schedulePath)
		if after == nil {
			return nil
		}
		if after.Sequence == ready.Sequence {
			_ = os.Remove(schedulePath)
			return nil
		}
	}
}

func urlPath(value string) string {
	return url.PathEscape(value)
}
