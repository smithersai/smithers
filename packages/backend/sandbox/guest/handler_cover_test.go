package guest

import (
	"context"
	"encoding/json"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func handlerCovWriteCommand(t *testing.T, dir, name, body string) {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatalf("write command shim %s: %v", name, err)
	}
}

func handlerCovSetPathWithCommands(t *testing.T, commands map[string]string) string {
	t.Helper()
	bin := t.TempDir()
	for name, body := range commands {
		handlerCovWriteCommand(t, bin, name, body)
	}
	t.Setenv("PATH", bin)
	return bin
}

func handlerCovReadTrimmed(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return strings.TrimSpace(string(data))
}

// --- Activity / session tracking --------------------------------------------

func TestHandlerCover_IdleTracking(t *testing.T) {
	h := NewHandler(time.Hour)
	if got := h.IdleSince(); got < 0 || got > time.Hour {
		t.Fatalf("IdleSince = %v, want small non-negative duration", got)
	}
	if h.IsIdle() {
		t.Error("IsIdle = true for a fresh handler with a 1h timeout, want false")
	}

	// A zero timeout means any elapsed time counts as idle.
	idle := NewHandler(0)
	time.Sleep(2 * time.Millisecond)
	if !idle.IsIdle() {
		t.Error("IsIdle = false for a 0 timeout handler, want true")
	}
}

func TestHandlerCover_SessionTracking(t *testing.T) {
	h := NewHandler(time.Hour)
	if got := h.ActiveSessionCount(); got != 0 {
		t.Fatalf("initial ActiveSessionCount = %d, want 0", got)
	}
	h.TrackSession("a")
	h.TrackSession("b")
	h.TrackSession("a") // re-tracking is idempotent on count
	if got := h.ActiveSessionCount(); got != 2 {
		t.Fatalf("ActiveSessionCount = %d, want 2", got)
	}
	h.RemoveSession("a")
	if got := h.ActiveSessionCount(); got != 1 {
		t.Fatalf("ActiveSessionCount after remove = %d, want 1", got)
	}
	h.RemoveSession("does-not-exist") // no-op, must not panic
	if got := h.ActiveSessionCount(); got != 1 {
		t.Fatalf("ActiveSessionCount after no-op remove = %d, want 1", got)
	}
}

// --- unmarshalParams ---------------------------------------------------------

func TestHandlerCover_UnmarshalParams(t *testing.T) {
	// Empty raw is a no-op success.
	var p ExecRequest
	if err := unmarshalParams(nil, &p); err != nil {
		t.Fatalf("empty params: %v", err)
	}
	// Valid JSON populates the destination.
	if err := unmarshalParams([]byte(`{"command":["ls"]}`), &p); err != nil {
		t.Fatalf("valid params: %v", err)
	}
	if len(p.Command) != 1 || p.Command[0] != "ls" {
		t.Fatalf("Command = %v, want [ls]", p.Command)
	}
	// Invalid JSON is rejected.
	err := unmarshalParams([]byte(`{bad`), &p)
	if err == nil || !strings.Contains(err.Error(), "invalid params") {
		t.Fatalf("invalid params err = %v, want invalid params", err)
	}
}

// --- handlePing / handleReady ------------------------------------------------

func TestHandlerCover_PingAndReady(t *testing.T) {
	h := NewHandler(time.Hour)
	if !h.handlePing().Pong {
		t.Error("handlePing Pong = false, want true")
	}
	if h.ready.Load() {
		t.Error("ready should start false")
	}
	if !h.handleReady().Ready {
		t.Error("handleReady Ready = false, want true")
	}
	if !h.ready.Load() {
		t.Error("handleReady must set the ready flag")
	}
}

// --- handleEnsureUser --------------------------------------------------------

func TestHandlerCover_EnsureUser_MissingUsername(t *testing.T) {
	h := NewHandler(time.Hour)
	_, err := h.handleEnsureUser(context.Background(), &EnsureUserRequest{})
	if err == nil || !strings.Contains(err.Error(), "username is required") {
		t.Fatalf("err = %v, want username is required", err)
	}
}

func TestHandlerCover_EnsureUser_ExistingUser(t *testing.T) {
	cur, err := user.Current()
	if err != nil {
		t.Skipf("cannot resolve current user: %v", err)
	}
	h := NewHandler(time.Hour)
	resp, err := h.handleEnsureUser(context.Background(), &EnsureUserRequest{Username: cur.Username})
	if err != nil {
		t.Fatalf("handleEnsureUser(existing): %v", err)
	}
	if resp.Created {
		t.Error("Created = true for an existing user, want false")
	}
	if resp.Home != cur.HomeDir {
		t.Errorf("Home = %q, want %q", resp.Home, cur.HomeDir)
	}
}

func TestHandler_Cov_EnsureUser_UseraddFailureAndPostCreateLookup(t *testing.T) {
	h := NewHandler(time.Hour)
	argsFile := filepath.Join(t.TempDir(), "useradd.args")
	handlerCovSetPathWithCommands(t, map[string]string{
		"useradd": `printf '%s\n' "$@" > "$HANDLER_COVER_ARGS"
printf 'useradd boom' >&2
exit 12
`,
	})
	t.Setenv("HANDLER_COVER_ARGS", argsFile)

	uid := int32(4242)
	_, err := h.handleEnsureUser(context.Background(), &EnsureUserRequest{
		Username: "no-such-cover-useradd-fail",
		Shell:    "/bin/zsh",
		Home:     "/home/cover-user",
		UID:      &uid,
		Groups:   []string{"staff", "docker"},
	})
	if err == nil || !strings.Contains(err.Error(), "useradd failed: useradd boom") {
		t.Fatalf("err = %v, want useradd failed with stderr", err)
	}
	args := "\n" + handlerCovReadTrimmed(t, argsFile) + "\n"
	for _, want := range []string{"\n-m\n", "\n-s\n", "\n/bin/zsh\n", "\n-d\n", "\n/home/cover-user\n", "\n-u\n", "\n4242\n", "\n-G\n", "\nstaff,docker\n", "\nno-such-cover-useradd-fail\n"} {
		if !strings.Contains(args, want) {
			t.Fatalf("useradd args %q missing %q", args, want)
		}
	}

	handlerCovSetPathWithCommands(t, map[string]string{
		"useradd": `exit 0
`,
	})
	_, err = h.handleEnsureUser(context.Background(), &EnsureUserRequest{
		Username: "no-such-cover-useradd-success-lookup-fail",
	})
	if err == nil || !strings.Contains(err.Error(), "lookup user after creation") {
		t.Fatalf("err = %v, want lookup user after creation", err)
	}
}

// --- handleExec --------------------------------------------------------------

func TestHandlerCover_Exec_MissingCommand(t *testing.T) {
	h := NewHandler(time.Hour)
	_, err := h.handleExec(context.Background(), &ExecRequest{})
	if err == nil || !strings.Contains(err.Error(), "command is required") {
		t.Fatalf("err = %v, want command is required", err)
	}
}

func TestHandlerCover_Exec_UserLookupError(t *testing.T) {
	h := NewHandler(time.Hour)
	_, err := h.handleExec(context.Background(), &ExecRequest{
		Command: []string{"true"},
		User:    "no-such-user-cover-xyz",
	})
	if err == nil || !strings.Contains(err.Error(), "lookup user") {
		t.Fatalf("err = %v, want lookup user error", err)
	}
}

func TestHandlerCover_Exec_EnvWorkdirStdin(t *testing.T) {
	h := NewHandler(time.Hour)
	dir := t.TempDir()
	resp, err := h.handleExec(context.Background(), &ExecRequest{
		Command: []string{"/bin/sh", "-c", "printf '%s' \"$COVER_VAR\"; pwd; cat"},
		Workdir: dir,
		Env:     map[string]string{"COVER_VAR": "hello"},
		Stdin:   "from-stdin",
	})
	if err != nil {
		t.Fatalf("handleExec: %v", err)
	}
	if resp.ExitCode != 0 {
		t.Fatalf("exit = %d, stderr = %q", resp.ExitCode, resp.Stderr)
	}
	if !strings.Contains(resp.Stdout, "hello") {
		t.Errorf("stdout %q missing env value", resp.Stdout)
	}
	if !strings.Contains(resp.Stdout, "from-stdin") {
		t.Errorf("stdout %q missing stdin echo", resp.Stdout)
	}
	// The workdir must be honored. macOS symlinks /tmp -> /private/tmp so
	// compare the base name to stay robust.
	if !strings.Contains(resp.Stdout, filepath.Base(dir)) {
		t.Errorf("stdout %q missing workdir %q", resp.Stdout, dir)
	}
}

func TestHandlerCover_Exec_NonZeroExit(t *testing.T) {
	h := NewHandler(time.Hour)
	resp, err := h.handleExec(context.Background(), &ExecRequest{
		Command: []string{"/bin/sh", "-c", "exit 7"},
	})
	if err != nil {
		t.Fatalf("handleExec should not error on a clean non-zero exit: %v", err)
	}
	if resp.ExitCode != 7 {
		t.Fatalf("ExitCode = %d, want 7", resp.ExitCode)
	}
}

func TestHandlerCover_Exec_CommandNotFound(t *testing.T) {
	h := NewHandler(time.Hour)
	_, err := h.handleExec(context.Background(), &ExecRequest{
		Command: []string{"/nonexistent/cover/binary"},
	})
	if err == nil || !strings.Contains(err.Error(), "exec failed") {
		t.Fatalf("err = %v, want exec failed", err)
	}
}

// --- handleWriteFile ---------------------------------------------------------

func TestHandlerCover_WriteFile_MissingPath(t *testing.T) {
	h := NewHandler(time.Hour)
	_, err := h.handleWriteFile(&WriteFileRequest{})
	if err == nil || !strings.Contains(err.Error(), "path is required") {
		t.Fatalf("err = %v, want path is required", err)
	}
}

func TestHandlerCover_WriteFile_Success(t *testing.T) {
	h := NewHandler(time.Hour)
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "out.txt")
	resp, err := h.handleWriteFile(&WriteFileRequest{
		Path:    path,
		Content: []byte("payload"),
		Mode:    0o600,
	})
	if err != nil {
		t.Fatalf("handleWriteFile: %v", err)
	}
	if resp.BytesWritten != len("payload") {
		t.Fatalf("BytesWritten = %d, want %d", resp.BytesWritten, len("payload"))
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(got) != "payload" {
		t.Fatalf("content = %q, want payload", got)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v, want 0600", info.Mode().Perm())
	}
}

func TestHandlerCover_WriteFile_OwnerCurrentUserAndGroup(t *testing.T) {
	cur, err := user.Current()
	if err != nil {
		t.Skipf("cannot resolve current user: %v", err)
	}
	grp, err := user.LookupGroupId(cur.Gid)
	if err != nil {
		t.Skipf("cannot resolve current group: %v", err)
	}
	h := NewHandler(time.Hour)
	dir := t.TempDir()
	path := filepath.Join(dir, "owned.txt")
	// Chown to our own uid/gid is permitted for a non-root owner, so this
	// exercises the successful owner-lookup + chown path.
	resp, err := h.handleWriteFile(&WriteFileRequest{
		Path:       path,
		Content:    []byte("x"),
		OwnerUser:  cur.Username,
		OwnerGroup: grp.Name,
	})
	if err != nil {
		t.Fatalf("handleWriteFile with owner: %v", err)
	}
	if resp.BytesWritten != 1 {
		t.Fatalf("BytesWritten = %d, want 1", resp.BytesWritten)
	}
}

func TestHandlerCover_WriteFile_OwnerUserLookupError(t *testing.T) {
	h := NewHandler(time.Hour)
	path := filepath.Join(t.TempDir(), "f.txt")
	_, err := h.handleWriteFile(&WriteFileRequest{
		Path:      path,
		Content:   []byte("x"),
		OwnerUser: "no-such-user-cover-xyz",
	})
	if err == nil || !strings.Contains(err.Error(), "lookup owner user") {
		t.Fatalf("err = %v, want lookup owner user", err)
	}
}

func TestHandlerCover_WriteFile_OwnerGroupLookupError(t *testing.T) {
	h := NewHandler(time.Hour)
	path := filepath.Join(t.TempDir(), "f.txt")
	_, err := h.handleWriteFile(&WriteFileRequest{
		Path:       path,
		Content:    []byte("x"),
		OwnerGroup: "no-such-group-cover-xyz",
	})
	if err == nil || !strings.Contains(err.Error(), "lookup owner group") {
		t.Fatalf("err = %v, want lookup owner group", err)
	}
}

func TestHandlerCover_WriteFile_ParentDirIsFile(t *testing.T) {
	h := NewHandler(time.Hour)
	dir := t.TempDir()
	// Create a regular file, then try to write "under" it as if it were a dir.
	blocker := filepath.Join(dir, "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatalf("seed blocker: %v", err)
	}
	_, err := h.handleWriteFile(&WriteFileRequest{
		Path:    filepath.Join(blocker, "child.txt"),
		Content: []byte("x"),
	})
	if err == nil || !strings.Contains(err.Error(), "create parent directory") {
		t.Fatalf("err = %v, want create parent directory", err)
	}
}

func TestHandlerCover_WriteFile_RenameTargetIsDir(t *testing.T) {
	h := NewHandler(time.Hour)
	dir := t.TempDir()
	// Target path is an existing directory; renaming the temp file onto it
	// fails at the rename step.
	target := filepath.Join(dir, "adir")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatalf("seed dir: %v", err)
	}
	_, err := h.handleWriteFile(&WriteFileRequest{
		Path:    target,
		Content: []byte("x"),
	})
	if err == nil || !strings.Contains(err.Error(), "rename temp to target") {
		t.Fatalf("err = %v, want rename temp to target", err)
	}
}

func TestHandler_Cov_WriteFile_CreateTempAndChownErrors(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("permission-denied branches are not reachable when tests run as root")
	}

	h := NewHandler(time.Hour)
	locked := filepath.Join(t.TempDir(), "locked")
	if err := os.Mkdir(locked, 0o500); err != nil {
		t.Fatalf("mkdir locked: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o700) })

	_, err := h.handleWriteFile(&WriteFileRequest{
		Path:    filepath.Join(locked, "out.txt"),
		Content: []byte("x"),
	})
	if err == nil || !strings.Contains(err.Error(), "create temp file") {
		t.Fatalf("err = %v, want create temp file", err)
	}

	_, err = h.handleWriteFile(&WriteFileRequest{
		Path:      filepath.Join(t.TempDir(), "root-owned.txt"),
		Content:   []byte("x"),
		OwnerUser: "root",
	})
	if err == nil || !strings.Contains(err.Error(), "chown temp file") {
		t.Fatalf("err = %v, want chown temp file", err)
	}
}

// --- handleReadFile ----------------------------------------------------------

func TestHandlerCover_ReadFile(t *testing.T) {
	h := NewHandler(time.Hour)

	_, err := h.handleReadFile(&ReadFileRequest{})
	if err == nil || !strings.Contains(err.Error(), "path is required") {
		t.Fatalf("missing path err = %v", err)
	}

	_, err = h.handleReadFile(&ReadFileRequest{Path: filepath.Join(t.TempDir(), "missing")})
	if err == nil || !strings.Contains(err.Error(), "read file") {
		t.Fatalf("missing file err = %v", err)
	}

	path := filepath.Join(t.TempDir(), "data")
	if err := os.WriteFile(path, []byte("abc"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	resp, err := h.handleReadFile(&ReadFileRequest{Path: path})
	if err != nil {
		t.Fatalf("handleReadFile: %v", err)
	}
	if string(resp.Content) != "abc" || resp.Size != 3 {
		t.Fatalf("Content=%q Size=%d, want abc/3", resp.Content, resp.Size)
	}
}

// --- handleDeleteFile --------------------------------------------------------

func TestHandlerCover_DeleteFile(t *testing.T) {
	h := NewHandler(time.Hour)

	_, err := h.handleDeleteFile(&DeleteFileRequest{})
	if err == nil || !strings.Contains(err.Error(), "path is required") {
		t.Fatalf("missing path err = %v", err)
	}

	// Deleting a missing file is a success with Deleted=false.
	resp, err := h.handleDeleteFile(&DeleteFileRequest{Path: filepath.Join(t.TempDir(), "gone")})
	if err != nil {
		t.Fatalf("delete missing: %v", err)
	}
	if resp.Deleted {
		t.Error("Deleted = true for a missing file, want false")
	}

	// Deleting an existing file removes it.
	path := filepath.Join(t.TempDir(), "victim")
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	resp, err = h.handleDeleteFile(&DeleteFileRequest{Path: path})
	if err != nil {
		t.Fatalf("delete existing: %v", err)
	}
	if !resp.Deleted {
		t.Error("Deleted = false for an existing file, want true")
	}

	// Removing a non-empty directory surfaces a non-IsNotExist error.
	nonEmpty := t.TempDir()
	if err := os.WriteFile(filepath.Join(nonEmpty, "inner"), []byte("x"), 0o644); err != nil {
		t.Fatalf("seed inner: %v", err)
	}
	_, err = h.handleDeleteFile(&DeleteFileRequest{Path: nonEmpty})
	if err == nil || !strings.Contains(err.Error(), "delete file") {
		t.Fatalf("delete non-empty dir err = %v, want delete file", err)
	}
}

// --- systemd-backed handlers -------------------------------------------------
// Missing-binary/error paths use the host PATH; success paths install local
// command shims so they can assert the handler logic without a real systemd.

func TestHandlerCover_CreateTransientUnit_Validation(t *testing.T) {
	h := NewHandler(time.Hour)
	_, err := h.handleCreateTransientUnit(context.Background(), &CreateTransientUnitRequest{})
	if err == nil || !strings.Contains(err.Error(), "name and exec are required") {
		t.Fatalf("err = %v, want name and exec are required", err)
	}
}

func TestHandlerCover_CreateTransientUnit_AllFieldsBuildThenFail(t *testing.T) {
	h := NewHandler(time.Hour)
	sec := int64(3)
	timeout := int64(9)
	_, err := h.handleCreateTransientUnit(context.Background(), &CreateTransientUnitRequest{
		Name:          "cover-transient", // no .service suffix -> exercises the append branch
		Mode:          UnitModeOneshot,
		Exec:          []string{"/bin/true"},
		User:          "root",
		Group:         "root",
		Workdir:       "/tmp",
		Env:           map[string]string{"K": "V"},
		After:         []string{"network.target"},
		Requires:      []string{"basic.target"},
		RestartPolicy: &RestartPolicy{Kind: "always", Sec: &sec},
		TimeoutSec:    &timeout,
	})
	// systemd-run is absent on this platform -> the exec step fails.
	if err == nil || !strings.Contains(err.Error(), "systemd-run failed") {
		t.Fatalf("err = %v, want systemd-run failed", err)
	}
}

func TestHandler_Cov_CreateTransientUnit_SuccessWithShim(t *testing.T) {
	h := NewHandler(time.Hour)
	argsFile := filepath.Join(t.TempDir(), "systemd-run.args")
	handlerCovSetPathWithCommands(t, map[string]string{
		"systemd-run": `printf '%s\n' "$@" > "$HANDLER_COVER_ARGS"
exit 0
`,
	})
	t.Setenv("HANDLER_COVER_ARGS", argsFile)

	sec := int64(3)
	timeout := int64(9)
	resp, err := h.handleCreateTransientUnit(context.Background(), &CreateTransientUnitRequest{
		Name:          "cover-transient-success",
		Mode:          UnitModeOneshot,
		Exec:          []string{"/bin/true", "--flag"},
		User:          "root",
		Group:         "root",
		Workdir:       "/tmp",
		Env:           map[string]string{"K": "V"},
		After:         []string{"network.target"},
		Requires:      []string{"basic.target"},
		RestartPolicy: &RestartPolicy{Kind: "always", Sec: &sec},
		TimeoutSec:    &timeout,
	})
	if err != nil {
		t.Fatalf("handleCreateTransientUnit: %v", err)
	}
	if resp.UnitName != "cover-transient-success.service" || !resp.Started {
		t.Fatalf("response = %+v, want suffixed started unit", resp)
	}
	args := "\n" + handlerCovReadTrimmed(t, argsFile) + "\n"
	for _, want := range []string{
		"\n--unit=cover-transient-success.service\n",
		"\n--remain-after-exit\n",
		"\n--uid=root\n",
		"\n--gid=root\n",
		"\n--working-directory=/tmp\n",
		"\n--setenv=K=V\n",
		"\n--property=Type=oneshot\n",
		"\n--property=Restart=always\n",
		"\n--property=RestartSec=3\n",
		"\n--property=TimeoutStartSec=9\n",
		"\n--property=After=network.target\n",
		"\n--property=Requires=basic.target\n",
		"\n--\n",
		"\n/bin/true\n",
		"\n--flag\n",
	} {
		if !strings.Contains(args, want) {
			t.Fatalf("systemd-run args %q missing %q", args, want)
		}
	}
}

func TestHandlerCover_CreatePersistentUnit_Validation(t *testing.T) {
	h := NewHandler(time.Hour)
	_, err := h.handleCreatePersistentUnit(context.Background(), &CreatePersistentUnitRequest{})
	if err == nil || !strings.Contains(err.Error(), "name and exec are required") {
		t.Fatalf("err = %v, want name and exec are required", err)
	}
}

func TestHandlerCover_CreatePersistentUnit_BuildsUnitFileThenWriteFails(t *testing.T) {
	h := NewHandler(time.Hour)
	sec := int64(5)
	timeout := int64(10)

	// Oneshot variant with an explicit WantedBy exercises the oneshot and
	// custom-install branches; the unit path under /etc/systemd/system is
	// not writable here so it fails at write_unit_file.
	_, err := h.handleCreatePersistentUnit(context.Background(), &CreatePersistentUnitRequest{
		Name:          "cover-persist",
		Mode:          UnitModeOneshot,
		Exec:          []string{"/bin/true", "--flag"},
		User:          "root",
		Group:         "root",
		Workdir:       "/tmp",
		Env:           map[string]string{"A": "B"},
		After:         []string{"network.target"},
		Requires:      []string{"basic.target"},
		WantedBy:      []string{"multi-user.target"},
		RestartPolicy: &RestartPolicy{Kind: "on-failure", Sec: &sec},
		TimeoutSec:    &timeout,
		Enable:        true,
	})
	if err == nil || !strings.Contains(err.Error(), "write unit file") {
		t.Fatalf("err = %v, want write unit file", err)
	}

	// Default (service) mode with no WantedBy exercises the simple-service and
	// default-install branches.
	_, err = h.handleCreatePersistentUnit(context.Background(), &CreatePersistentUnitRequest{
		Name: "cover-persist-simple.service", // already suffixed
		Exec: []string{"/bin/true"},
	})
	if err == nil || !strings.Contains(err.Error(), "write unit file") {
		t.Fatalf("err = %v, want write unit file (simple)", err)
	}
}

func TestHandler_Cov_CreatePersistentUnit_FieldValidationBranches(t *testing.T) {
	h := NewHandler(time.Hour)
	base := func() *CreatePersistentUnitRequest {
		return &CreatePersistentUnitRequest{
			Name: "cover-persist-valid",
			Exec: []string{"/bin/true"},
		}
	}

	cases := []struct {
		name    string
		mutate  func(*CreatePersistentUnitRequest)
		wantSub string
	}{
		{"name", func(r *CreatePersistentUnitRequest) { r.Name = "bad\nname" }, "name contains a newline"},
		{"after", func(r *CreatePersistentUnitRequest) { r.After = []string{"bad\nafter"} }, "after[0] contains a newline"},
		{"requires", func(r *CreatePersistentUnitRequest) { r.Requires = []string{"bad\nrequires"} }, "requires[0] contains a newline"},
		{"exec", func(r *CreatePersistentUnitRequest) { r.Exec = []string{"/bin/true", "bad\x00exec"} }, "exec[1] contains a NUL"},
		{"user", func(r *CreatePersistentUnitRequest) { r.User = "bad\nuser" }, "user contains a newline"},
		{"group", func(r *CreatePersistentUnitRequest) { r.Group = "bad\ngroup" }, "group contains a newline"},
		{"workdir", func(r *CreatePersistentUnitRequest) { r.Workdir = "/tmp/bad\nworkdir" }, "workdir contains a newline"},
		{"env key", func(r *CreatePersistentUnitRequest) { r.Env = map[string]string{"bad\x7fkey": "v"} }, "env key contains a control character"},
		{"env value", func(r *CreatePersistentUnitRequest) { r.Env = map[string]string{"K": "bad\nvalue"} }, "env[K] contains a newline"},
		{"restart policy", func(r *CreatePersistentUnitRequest) { r.RestartPolicy = &RestartPolicy{Kind: "bad\npolicy"} }, "restart policy kind contains a newline"},
		{"wanted_by", func(r *CreatePersistentUnitRequest) { r.WantedBy = []string{"bad\nwanted"} }, "wanted_by[0] contains a newline"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := base()
			tc.mutate(req)
			_, err := h.handleCreatePersistentUnit(context.Background(), req)
			if err == nil || !strings.Contains(err.Error(), tc.wantSub) {
				t.Fatalf("err = %v, want substring %q", err, tc.wantSub)
			}
		})
	}
}

func TestHandlerCover_RestartUnit(t *testing.T) {
	h := NewHandler(time.Hour)
	_, err := h.handleRestartUnit(context.Background(), &RestartUnitRequest{})
	if err == nil || !strings.Contains(err.Error(), "name is required") {
		t.Fatalf("missing name err = %v", err)
	}
	// Bare name -> .service appended; systemctl absent -> restart fails.
	_, err = h.handleRestartUnit(context.Background(), &RestartUnitRequest{Name: "cover-unit"})
	if err == nil || !strings.Contains(err.Error(), "restart unit failed") {
		t.Fatalf("bare name err = %v, want restart unit failed", err)
	}
	// Already-suffixed name skips the append branch.
	_, err = h.handleRestartUnit(context.Background(), &RestartUnitRequest{Name: "cover-unit.timer"})
	if err == nil || !strings.Contains(err.Error(), "restart unit failed") {
		t.Fatalf("suffixed name err = %v, want restart unit failed", err)
	}
}

func TestHandler_Cov_RestartUnit_SuccessWithShim(t *testing.T) {
	h := NewHandler(time.Hour)
	argsFile := filepath.Join(t.TempDir(), "systemctl.args")
	handlerCovSetPathWithCommands(t, map[string]string{
		"systemctl": `printf '%s\n' "$@" > "$HANDLER_COVER_ARGS"
exit 0
`,
	})
	t.Setenv("HANDLER_COVER_ARGS", argsFile)

	resp, err := h.handleRestartUnit(context.Background(), &RestartUnitRequest{Name: "cover-restart"})
	if err != nil {
		t.Fatalf("handleRestartUnit: %v", err)
	}
	if !resp.Restarted {
		t.Fatal("Restarted = false, want true")
	}
	args := "\n" + handlerCovReadTrimmed(t, argsFile) + "\n"
	for _, want := range []string{"\nrestart\n", "\ncover-restart.service\n"} {
		if !strings.Contains(args, want) {
			t.Fatalf("systemctl args %q missing %q", args, want)
		}
	}
}

func TestHandlerCover_UnitStatus(t *testing.T) {
	handlerCovSetPathWithCommands(t, map[string]string{"systemctl": "exit 7\n"})
	h := NewHandler(time.Hour)
	_, err := h.handleUnitStatus(context.Background(), &UnitStatusRequest{})
	if err == nil || !strings.Contains(err.Error(), "name is required") {
		t.Fatalf("missing name err = %v", err)
	}
	_, err = h.handleUnitStatus(context.Background(), &UnitStatusRequest{Name: "cover-unit.socket"})
	if err == nil || !strings.Contains(err.Error(), "systemctl show failed") {
		t.Fatalf("status err = %v, want systemctl show failed", err)
	}
}

func TestHandler_Cov_UnitStatus_SuccessWithShim(t *testing.T) {
	h := NewHandler(time.Hour)
	handlerCovSetPathWithCommands(t, map[string]string{
		"systemctl": `if [ "$1" = "show" ]; then
  printf 'LoadState=loaded\n'
  printf 'ActiveState=active\n'
  printf 'SubState=running\n'
  printf 'Description=Cover Service\n'
  printf 'ignored-line-without-equals\n'
  printf 'Other=ignored\n'
  exit 0
fi
exit 7
`,
	})

	resp, err := h.handleUnitStatus(context.Background(), &UnitStatusRequest{Name: "cover-status"})
	if err != nil {
		t.Fatalf("handleUnitStatus: %v", err)
	}
	if resp.Name != "cover-status.service" {
		t.Fatalf("Name = %q, want cover-status.service", resp.Name)
	}
	if resp.LoadState != "loaded" || resp.ActiveState != "active" || resp.SubState != "running" || resp.Description != "Cover Service" {
		t.Fatalf("parsed status = %+v", resp)
	}
}

func TestHandlerCover_TailJournal(t *testing.T) {
	handlerCovSetPathWithCommands(t, map[string]string{"journalctl": "printf 'journal unavailable' >&2\nexit 7\n"})
	h := NewHandler(time.Hour)
	_, err := h.handleTailJournal(context.Background(), &TailJournalRequest{})
	if err == nil || !strings.Contains(err.Error(), "unit is required") {
		t.Fatalf("missing unit err = %v", err)
	}
	// Default line count (Lines<=0 -> 100); journalctl refuses the request.
	_, err = h.handleTailJournal(context.Background(), &TailJournalRequest{Unit: "cover.service"})
	if err == nil || !strings.Contains(err.Error(), "journalctl failed") {
		t.Fatalf("default lines err = %v, want journalctl failed", err)
	}
	// Explicit positive line count exercises the non-default branch.
	_, err = h.handleTailJournal(context.Background(), &TailJournalRequest{Unit: "cover.service", Lines: 25})
	if err == nil || !strings.Contains(err.Error(), "journalctl failed") {
		t.Fatalf("explicit lines err = %v, want journalctl failed", err)
	}
}

func TestHandler_Cov_TailJournal_SuccessAndEmptyWithShim(t *testing.T) {
	h := NewHandler(time.Hour)
	handlerCovSetPathWithCommands(t, map[string]string{
		"journalctl": `case "$HANDLER_COVER_JOURNAL_MODE" in
empty-exit-one)
  exit 1
  ;;
empty-output)
  exit 0
  ;;
*)
  printf '2026-01-01T00:00:00Z first\n'
  printf '2026-01-01T00:00:01Z second\n'
  exit 0
  ;;
esac
`,
	})

	resp, err := h.handleTailJournal(context.Background(), &TailJournalRequest{Unit: "cover.service", Lines: 2})
	if err != nil {
		t.Fatalf("handleTailJournal: %v", err)
	}
	if len(resp.Lines) != 2 || resp.Lines[0] != "2026-01-01T00:00:00Z first" || resp.More {
		t.Fatalf("response = %+v, want two lines and More=false", resp)
	}

	t.Setenv("HANDLER_COVER_JOURNAL_MODE", "empty-output")
	resp, err = h.handleTailJournal(context.Background(), &TailJournalRequest{Unit: "cover.service", Lines: 2})
	if err != nil {
		t.Fatalf("handleTailJournal empty output: %v", err)
	}
	if len(resp.Lines) != 0 {
		t.Fatalf("empty output Lines = %v, want empty", resp.Lines)
	}

	t.Setenv("HANDLER_COVER_JOURNAL_MODE", "empty-exit-one")
	resp, err = h.handleTailJournal(context.Background(), &TailJournalRequest{Unit: "cover.service", Lines: 2})
	if err != nil {
		t.Fatalf("handleTailJournal exit 1: %v", err)
	}
	if len(resp.Lines) != 0 {
		t.Fatalf("exit 1 Lines = %v, want empty", resp.Lines)
	}
}

// --- handlePrepareSnapshot / handlePostResume --------------------------------

func TestHandlerCover_PrepareSnapshot(t *testing.T) {
	h := NewHandler(time.Hour)
	// `sync` exists on this platform, so the happy path is reachable; the
	// drop_caches write to /proc is best-effort and its error is ignored.
	resp, err := h.handlePrepareSnapshot(context.Background())
	if err != nil {
		t.Fatalf("handlePrepareSnapshot: %v", err)
	}
	if !resp.Synced {
		t.Error("Synced = false, want true")
	}
}

func TestHandler_Cov_PrepareSnapshot_SyncFailureThroughDispatch(t *testing.T) {
	h := NewHandler(time.Hour)
	handlerCovSetPathWithCommands(t, map[string]string{
		"sync": `printf 'sync boom' >&2
exit 4
`,
	})

	resp := h.HandleRequest(context.Background(), &Request{
		ID:     "prep-fail",
		Method: MethodPrepareSnapshot,
	})
	if resp.Error == "" || !strings.Contains(resp.Error, "sync failed: sync boom") {
		t.Fatalf("Error = %q, want sync failed with stderr", resp.Error)
	}
	if resp.ErrorCode != ErrorCodeInternal {
		t.Fatalf("ErrorCode = %q, want %q", resp.ErrorCode, ErrorCodeInternal)
	}
}

func TestHandlerCover_PostResume_NoNTPClient(t *testing.T) {
	h := NewHandler(time.Hour)
	// Neither chronyc nor ntpdate is on PATH here, so the "no NTP client"
	// branch runs and clock refresh is reported as false.
	resp := h.handlePostResume(context.Background())
	if resp.ClockRefreshed {
		t.Error("ClockRefreshed = true, want false when no NTP client is available")
	}
}

func TestHandler_Cov_PostResume_NTPClientBranches(t *testing.T) {
	h := NewHandler(time.Hour)
	handlerCovSetPathWithCommands(t, map[string]string{
		"chronyc": `case "$HANDLER_COVER_NTP_MODE" in
chronyc-fail)
  printf 'chronyc boom' >&2
  exit 3
  ;;
*)
  exit 0
  ;;
esac
`,
	})

	resp := h.handlePostResume(context.Background())
	if !resp.ClockRefreshed {
		t.Fatal("ClockRefreshed = false, want true for chronyc success")
	}

	t.Setenv("HANDLER_COVER_NTP_MODE", "chronyc-fail")
	resp = h.handlePostResume(context.Background())
	if resp.ClockRefreshed {
		t.Fatal("ClockRefreshed = true, want false for chronyc failure")
	}

	handlerCovSetPathWithCommands(t, map[string]string{
		"ntpdate": `case "$HANDLER_COVER_NTP_MODE" in
ntpdate-fail)
  printf 'ntpdate boom' >&2
  exit 5
  ;;
*)
  exit 0
  ;;
esac
`,
	})
	t.Setenv("HANDLER_COVER_NTP_MODE", "")
	resp = h.handlePostResume(context.Background())
	if !resp.ClockRefreshed {
		t.Fatal("ClockRefreshed = false, want true for ntpdate success")
	}

	t.Setenv("HANDLER_COVER_NTP_MODE", "ntpdate-fail")
	resp = h.handlePostResume(context.Background())
	if resp.ClockRefreshed {
		t.Fatal("ClockRefreshed = true, want false for ntpdate failure")
	}
}

// --- handleEmitApprovalRequest additional branches ---------------------------

func TestHandlerCover_EmitApprovalRequest_Limits(t *testing.T) {
	h := NewHandler(time.Hour)
	big := func(n int) string { return strings.Repeat("x", n) }

	cases := []struct {
		name    string
		req     EmitApprovalRequestRequest
		wantSub string
	}{
		{"kind too long", EmitApprovalRequestRequest{SessionID: "s", Kind: big(65), Title: "t"}, "kind exceeds 64 bytes"},
		{"title too long", EmitApprovalRequestRequest{SessionID: "s", Kind: "k", Title: big(513)}, "title exceeds 512 bytes"},
		{"description too long", EmitApprovalRequestRequest{SessionID: "s", Kind: "k", Title: "t", Description: big(4097)}, "description exceeds 4096 bytes"},
		{"payload too big", EmitApprovalRequestRequest{SessionID: "s", Kind: "k", Title: "t", Payload: json.RawMessage(append(append([]byte(`{"x":"`), []byte(strings.Repeat("a", 256*1024))...), []byte(`"}`)...))}, "payload exceeds"},
		{"payload invalid json", EmitApprovalRequestRequest{SessionID: "s", Kind: "k", Title: "t", Payload: json.RawMessage(`not-json`)}, "payload is not valid JSON"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := h.handleEmitApprovalRequest(&tc.req)
			if err == nil || !strings.Contains(err.Error(), tc.wantSub) {
				t.Fatalf("err = %v, want substring %q", err, tc.wantSub)
			}
		})
	}
}

func TestHandlerCover_EmitApprovalRequest_ValidExpiresAt(t *testing.T) {
	h := NewHandler(time.Hour)
	resp, err := h.handleEmitApprovalRequest(&EmitApprovalRequestRequest{
		SessionID: "s",
		Kind:      "k",
		Title:     "t",
		ExpiresAt: time.Now().UTC().Format(time.RFC3339),
	})
	if err != nil {
		t.Fatalf("handleEmitApprovalRequest with valid expires_at: %v", err)
	}
	if !resp.Accepted {
		t.Error("Accepted = false, want true")
	}
}

// --- handleWriteDevtoolsSnapshot: no-payload accept ---------------------------

func TestHandlerCover_WriteDevtoolsSnapshot_NoPayload(t *testing.T) {
	h := NewHandler(time.Hour)
	resp, err := h.handleWriteDevtoolsSnapshot(&WriteDevtoolsSnapshotRequest{
		SessionID: "s",
		Kind:      "tool_state",
	})
	if err != nil {
		t.Fatalf("handleWriteDevtoolsSnapshot without payload: %v", err)
	}
	if !resp.Accepted {
		t.Error("Accepted = false, want true")
	}
}

func TestHandler_Cov_WriteDevtoolsSnapshot_DirectInvalidJSON(t *testing.T) {
	h := NewHandler(time.Hour)
	_, err := h.handleWriteDevtoolsSnapshot(&WriteDevtoolsSnapshotRequest{
		SessionID: "s",
		Kind:      "tool_state",
		Payload:   json.RawMessage(`{`),
	})
	if err == nil || !strings.Contains(err.Error(), "payload is not valid JSON") {
		t.Fatalf("err = %v, want payload is not valid JSON", err)
	}
}

// --- HandleRequest dispatch coverage -----------------------------------------

// Methods with legacy plain-Error branches return immediately on malformed
// params, before the shared internal-code backfill at the end of dispatch.
func TestHandlerCover_HandleRequest_InvalidParamsDispatch(t *testing.T) {
	h := NewHandler(time.Hour)
	bad := json.RawMessage(`{`)
	methods := []string{
		MethodEnsureUser,
		MethodExec,
		MethodWriteFile,
		MethodReadFile,
		MethodDeleteFile,
		MethodCreateTransientUnit,
		MethodCreatePersistentUnit,
		MethodRestartUnit,
		MethodUnitStatus,
		MethodTailJournal,
	}
	for _, m := range methods {
		t.Run(m, func(t *testing.T) {
			resp := h.HandleRequest(context.Background(), &Request{ID: "1", Method: m, Params: bad})
			if resp.Error == "" {
				t.Fatalf("Error empty for invalid params on %s", m)
			}
			if !strings.Contains(resp.Error, "invalid params") {
				t.Fatalf("Error = %q for %s, want invalid params", resp.Error, m)
			}
			if resp.ErrorCode != "" {
				t.Fatalf("ErrorCode = %q for %s, want empty legacy error code", resp.ErrorCode, m)
			}
		})
	}
}

func TestHandler_Cov_HandleRequest_HelloInvalidParams(t *testing.T) {
	h := NewHandler(time.Hour)
	resp := h.HandleRequest(context.Background(), &Request{
		ID:     "hello-bad",
		Method: MethodHello,
		Params: json.RawMessage(`{`),
	})
	if resp.Error == "" || !strings.Contains(resp.Error, "invalid params") {
		t.Fatalf("Error = %q, want invalid params", resp.Error)
	}
	if resp.ErrorCode != ErrorCodeInvalidParams {
		t.Fatalf("ErrorCode = %q, want %q", resp.ErrorCode, ErrorCodeInvalidParams)
	}
}

func TestHandler_Cov_HandleRequest_AdditionalSuccessDispatch(t *testing.T) {
	h := NewHandler(time.Hour)

	cur, err := user.Current()
	if err != nil {
		t.Skipf("cannot resolve current user: %v", err)
	}

	resp := h.HandleRequest(context.Background(), &Request{
		ID:     "ensure",
		Method: MethodEnsureUser,
		Params: MarshalResult(EnsureUserRequest{Username: cur.Username}),
	})
	if resp.Error != "" || len(resp.Result) == 0 {
		t.Fatalf("EnsureUser dispatch error/result = %q/%s", resp.Error, string(resp.Result))
	}

	resp = h.HandleRequest(context.Background(), &Request{
		ID:     "exec",
		Method: MethodExec,
		Params: MarshalResult(ExecRequest{Command: []string{"/bin/sh", "-c", "printf ok"}}),
	})
	if resp.Error != "" || len(resp.Result) == 0 {
		t.Fatalf("Exec dispatch error/result = %q/%s", resp.Error, string(resp.Result))
	}
	var execResp ExecResponse
	if err := json.Unmarshal(resp.Result, &execResp); err != nil {
		t.Fatalf("unmarshal exec result: %v", err)
	}
	if execResp.ExitCode != 0 || execResp.Stdout != "ok" {
		t.Fatalf("Exec result = %+v, want exit 0 stdout ok", execResp)
	}
}

func TestHandler_Cov_HandleRequest_SystemCommandSuccessDispatch(t *testing.T) {
	h := NewHandler(time.Hour)
	handlerCovSetPathWithCommands(t, map[string]string{
		"systemd-run": `exit 0
`,
		"systemctl": `case "$1" in
restart)
  exit 0
  ;;
show)
  printf 'LoadState=loaded\nActiveState=active\nSubState=running\nDescription=Dispatch Service\n'
  exit 0
  ;;
*)
  exit 6
  ;;
esac
`,
		"journalctl": `printf 'line one\nline two\n'
exit 0
`,
	})

	cases := []struct {
		name   string
		method string
		params any
	}{
		{"transient", MethodCreateTransientUnit, CreateTransientUnitRequest{Name: "dispatch-transient", Exec: []string{"/bin/true"}}},
		{"restart", MethodRestartUnit, RestartUnitRequest{Name: "dispatch-restart"}},
		{"status", MethodUnitStatus, UnitStatusRequest{Name: "dispatch-status"}},
		{"journal", MethodTailJournal, TailJournalRequest{Unit: "dispatch.service", Lines: 2}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := h.HandleRequest(context.Background(), &Request{
				ID:     tc.name,
				Method: tc.method,
				Params: MarshalResult(tc.params),
			})
			if resp.Error != "" || resp.ErrorCode != "" {
				t.Fatalf("%s dispatch error = %q/%q", tc.method, resp.Error, resp.ErrorCode)
			}
			if len(resp.Result) == 0 {
				t.Fatalf("%s dispatch returned empty result", tc.method)
			}
		})
	}
}

// Dispatch the result-producing methods that succeed on this platform and
// confirm HandleRequest wires the result through with no error.
func TestHandlerCover_HandleRequest_SuccessDispatch(t *testing.T) {
	h := NewHandler(time.Hour)
	dir := t.TempDir()
	writePath := filepath.Join(dir, "wf.txt")
	readPath := filepath.Join(dir, "rf.txt")
	if err := os.WriteFile(readPath, []byte("hi"), 0o644); err != nil {
		t.Fatalf("seed read file: %v", err)
	}
	delPath := filepath.Join(dir, "df.txt")
	if err := os.WriteFile(delPath, []byte("x"), 0o644); err != nil {
		t.Fatalf("seed del file: %v", err)
	}

	cases := []struct {
		name   string
		method string
		params any
	}{
		{"ping", MethodPing, PingRequest{}},
		{"ready", MethodReady, ReadyRequest{}},
		{"writefile", MethodWriteFile, WriteFileRequest{Path: writePath, Content: []byte("z")}},
		{"readfile", MethodReadFile, ReadFileRequest{Path: readPath}},
		{"deletefile", MethodDeleteFile, DeleteFileRequest{Path: delPath}},
		{"prepare_snapshot", MethodPrepareSnapshot, PrepareSnapshotRequest{}},
		{"post_resume", MethodPostResume, PostResumeRequest{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := h.HandleRequest(context.Background(), &Request{
				ID:     "1",
				Method: tc.method,
				Params: MarshalResult(tc.params),
			})
			if resp.Error != "" || resp.ErrorCode != "" {
				t.Fatalf("%s: unexpected error %q / %q", tc.method, resp.Error, resp.ErrorCode)
			}
			if len(resp.Result) == 0 {
				t.Fatalf("%s: empty result", tc.method)
			}
		})
	}
}

// Dispatch failing handlers with deterministic command refusals and confirm HandleRequest surfaces the
// error with the backfilled internal code.
func TestHandlerCover_HandleRequest_ErrorDispatch(t *testing.T) {
	handlerCovSetPathWithCommands(t, map[string]string{
		"systemctl":   "exit 7\n",
		"systemd-run": "exit 7\n",
		"journalctl":  "printf 'journal unavailable' >&2\nexit 7\n",
	})
	h := NewHandler(time.Hour)
	cases := []struct {
		name   string
		method string
		params any
	}{
		{"ensure_user_missing", MethodEnsureUser, EnsureUserRequest{}},
		{"exec_missing_cmd", MethodExec, ExecRequest{}},
		{"writefile_missing_path", MethodWriteFile, WriteFileRequest{}},
		{"readfile_missing_path", MethodReadFile, ReadFileRequest{}},
		{"deletefile_missing_path", MethodDeleteFile, DeleteFileRequest{}},
		{"transient_unit", MethodCreateTransientUnit, CreateTransientUnitRequest{Name: "u", Exec: []string{"/bin/true"}}},
		{"persistent_unit", MethodCreatePersistentUnit, CreatePersistentUnitRequest{Name: "u", Exec: []string{"/bin/true"}}},
		{"restart_unit", MethodRestartUnit, RestartUnitRequest{Name: "u"}},
		{"unit_status", MethodUnitStatus, UnitStatusRequest{Name: "u"}},
		{"tail_journal", MethodTailJournal, TailJournalRequest{Unit: "u"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := h.HandleRequest(context.Background(), &Request{
				ID:     "1",
				Method: tc.method,
				Params: MarshalResult(tc.params),
			})
			if resp.Error == "" {
				t.Fatalf("%s: expected an error, got none", tc.method)
			}
			if resp.ErrorCode != ErrorCodeInternal {
				t.Fatalf("%s: ErrorCode = %q, want %q", tc.method, resp.ErrorCode, ErrorCodeInternal)
			}
		})
	}
}
