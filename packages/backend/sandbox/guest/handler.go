package guest

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/sandbox"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// Resource caps for RPC handlers. Every handler that shells out or reads
// files must bound what it buffers: the guest agent shares the VM's memory
// with the workload, so one unbounded response can OOM the whole sandbox.
const (
	// maxExecOutputBytes caps captured stdout and stderr (each) for Exec.
	maxExecOutputBytes = 8 << 20 // 8 MiB

	// defaultExecTimeout bounds Exec commands whose request carries no
	// explicit timeout_sec, so an abandoned command cannot run forever.
	defaultExecTimeout = 10 * time.Minute

	// maxReadFileBytes caps ReadFile responses. The content is base64-encoded
	// into a JSON frame that must stay under the 64 MiB wire cap.
	maxReadFileBytes = 32 << 20 // 32 MiB

	// maxTailJournalLines clamps the caller-supplied line count for
	// TailJournal.
	maxTailJournalLines = 5000

	// maxTailJournalBytes caps buffered journalctl output for TailJournal.
	maxTailJournalBytes = 4 << 20 // 4 MiB
)

// cappedBuffer is an io.Writer that retains at most max bytes and records
// whether any input was dropped. It never returns an error, so commands keep
// running (and draining their pipes) after the cap is hit.
type cappedBuffer struct {
	buf       bytes.Buffer
	max       int
	truncated bool
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if remain := b.max - b.buf.Len(); remain > 0 {
		if len(p) > remain {
			p = p[:remain]
			b.truncated = true
		}
		b.buf.Write(p)
	} else if n > 0 {
		b.truncated = true
	}
	return n, nil
}

// Handler processes guest agent RPC requests and tracks workspace activity.
type Handler struct {
	mu             sync.Mutex
	activeSessions map[string]time.Time // session ID -> last active timestamp
	lastActive     atomic.Int64         // unix timestamp of last activity
	idleTimeout    time.Duration
	ready          atomic.Bool
}

type guestTempFile interface {
	Write([]byte) (int, error)
	Sync() error
	Chmod(os.FileMode) error
	Close() error
	Name() string
}

var (
	guestLookupUser      = user.Lookup
	guestLookupGroup     = user.LookupGroup
	guestMkdirAll        = os.MkdirAll
	guestCreateTemp      = func(dir, pattern string) (guestTempFile, error) { return os.CreateTemp(dir, pattern) }
	guestRemove          = os.Remove
	guestRename          = os.Rename
	guestChown           = os.Chown
	guestSystemdUnitPath = "/etc/systemd/system"
)

// NewHandler creates a Handler with the given idle timeout.
func NewHandler(idleTimeout time.Duration) *Handler {
	h := &Handler{
		activeSessions: make(map[string]time.Time),
		idleTimeout:    idleTimeout,
	}
	h.touchActivity()
	return h
}

// touchActivity records the current time as the last activity.
func (h *Handler) touchActivity() {
	h.lastActive.Store(time.Now().Unix())
}

// IdleSince returns the duration since the last activity.
func (h *Handler) IdleSince() time.Duration {
	last := time.Unix(h.lastActive.Load(), 0)
	return time.Since(last)
}

// IsIdle returns true if the idle duration exceeds the configured timeout.
func (h *Handler) IsIdle() bool {
	return h.IdleSince() > h.idleTimeout
}

// TrackSession records activity for a named session.
func (h *Handler) TrackSession(sessionID string) {
	h.mu.Lock()
	h.activeSessions[sessionID] = time.Now()
	h.mu.Unlock()
	h.touchActivity()
}

// RemoveSession removes a tracked session.
func (h *Handler) RemoveSession(sessionID string) {
	h.mu.Lock()
	delete(h.activeSessions, sessionID)
	h.mu.Unlock()
}

// ActiveSessionCount returns the number of active sessions.
func (h *Handler) ActiveSessionCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.activeSessions)
}

// HandleRequest dispatches an RPC request to the appropriate handler method
// and returns a Response. It never returns an error; all errors are encoded
// in the Response.Error / Response.ErrorCode fields.
func (h *Handler) HandleRequest(ctx context.Context, req *Request) *Response {
	h.touchActivity()

	resp := &Response{ID: req.ID}

	switch req.Method {
	case MethodHello:
		var p HelloRequest
		if err := unmarshalParams(req.Params, &p); err != nil {
			setErr(resp, ErrorCodeInvalidParams, err)
			return resp
		}
		resp.Result = MarshalResult(h.handleHello(&p))

	case MethodPing:
		resp.Result = MarshalResult(h.handlePing())

	case MethodReady:
		resp.Result = MarshalResult(h.handleReady())

	case MethodEnsureUser:
		var p EnsureUserRequest
		if err := unmarshalParams(req.Params, &p); err != nil {
			resp.Error = err.Error()
			return resp
		}
		result, err := h.handleEnsureUser(ctx, &p)
		if err != nil {
			resp.Error = err.Error()
		} else {
			resp.Result = MarshalResult(result)
		}

	case MethodExec:
		var p ExecRequest
		if err := unmarshalParams(req.Params, &p); err != nil {
			resp.Error = err.Error()
			return resp
		}
		result, err := h.handleExec(ctx, &p)
		if err != nil {
			resp.Error = err.Error()
		} else {
			resp.Result = MarshalResult(result)
		}

	case MethodWriteFile:
		var p WriteFileRequest
		if err := unmarshalParams(req.Params, &p); err != nil {
			resp.Error = err.Error()
			return resp
		}
		result, err := h.handleWriteFile(&p)
		if err != nil {
			resp.Error = err.Error()
		} else {
			resp.Result = MarshalResult(result)
		}

	case MethodReadFile:
		var p ReadFileRequest
		if err := unmarshalParams(req.Params, &p); err != nil {
			resp.Error = err.Error()
			return resp
		}
		result, err := h.handleReadFile(&p)
		if err != nil {
			resp.Error = err.Error()
		} else {
			resp.Result = MarshalResult(result)
		}

	case MethodDeleteFile:
		var p DeleteFileRequest
		if err := unmarshalParams(req.Params, &p); err != nil {
			resp.Error = err.Error()
			return resp
		}
		result, err := h.handleDeleteFile(&p)
		if err != nil {
			resp.Error = err.Error()
		} else {
			resp.Result = MarshalResult(result)
		}

	case MethodCreateTransientUnit:
		var p CreateTransientUnitRequest
		if err := unmarshalParams(req.Params, &p); err != nil {
			resp.Error = err.Error()
			return resp
		}
		result, err := h.handleCreateTransientUnit(ctx, &p)
		if err != nil {
			resp.Error = err.Error()
		} else {
			resp.Result = MarshalResult(result)
		}

	case MethodCreatePersistentUnit:
		var p CreatePersistentUnitRequest
		if err := unmarshalParams(req.Params, &p); err != nil {
			resp.Error = err.Error()
			return resp
		}
		result, err := h.handleCreatePersistentUnit(ctx, &p)
		if err != nil {
			resp.Error = err.Error()
		} else {
			resp.Result = MarshalResult(result)
		}

	case MethodRestartUnit:
		var p RestartUnitRequest
		if err := unmarshalParams(req.Params, &p); err != nil {
			resp.Error = err.Error()
			return resp
		}
		result, err := h.handleRestartUnit(ctx, &p)
		if err != nil {
			resp.Error = err.Error()
		} else {
			resp.Result = MarshalResult(result)
		}

	case MethodUnitStatus:
		var p UnitStatusRequest
		if err := unmarshalParams(req.Params, &p); err != nil {
			resp.Error = err.Error()
			return resp
		}
		result, err := h.handleUnitStatus(ctx, &p)
		if err != nil {
			resp.Error = err.Error()
		} else {
			resp.Result = MarshalResult(result)
		}

	case MethodTailJournal:
		var p TailJournalRequest
		if err := unmarshalParams(req.Params, &p); err != nil {
			resp.Error = err.Error()
			return resp
		}
		result, err := h.handleTailJournal(ctx, &p)
		if err != nil {
			resp.Error = err.Error()
		} else {
			resp.Result = MarshalResult(result)
		}

	case MethodPrepareSnapshot:
		result, err := h.handlePrepareSnapshot(ctx)
		if err != nil {
			resp.Error = err.Error()
		} else {
			resp.Result = MarshalResult(result)
		}

	case MethodPostResume:
		resp.Result = MarshalResult(h.handlePostResume(ctx))

	case MethodEmitApprovalRequest:
		var p EmitApprovalRequestRequest
		if err := unmarshalParams(req.Params, &p); err != nil {
			setErr(resp, ErrorCodeInvalidParams, err)
			return resp
		}
		result, err := h.handleEmitApprovalRequest(&p)
		if err != nil {
			setErr(resp, ErrorCodeInvalidParams, err)
		} else {
			resp.Result = MarshalResult(result)
		}

	case MethodWriteDevtoolsSnapshot:
		var p WriteDevtoolsSnapshotRequest
		if err := unmarshalParams(req.Params, &p); err != nil {
			setErr(resp, ErrorCodeInvalidParams, err)
			return resp
		}
		result, err := h.handleWriteDevtoolsSnapshot(&p)
		if err != nil {
			setErr(resp, ErrorCodeInvalidParams, err)
		} else {
			resp.Result = MarshalResult(result)
		}

	default:
		resp.Error = fmt.Sprintf("unknown method: %s", req.Method)
		resp.ErrorCode = ErrorCodeUnknownMethod
	}

	// Backfill ErrorCode for dispatch branches that only set Error. Any
	// non-empty Error with no explicit code is classified as internal; branches
	// that need a more specific code (unknown method, invalid params) set it
	// directly above.
	if resp.Error != "" && resp.ErrorCode == "" {
		resp.ErrorCode = ErrorCodeInternal
	}

	return resp
}

// setErr sets both legacy Error and structured ErrorCode on resp.
func setErr(resp *Response, code string, err error) {
	resp.Error = err.Error()
	resp.ErrorCode = code
}

// handleHello returns this guest build's protocol version and capability set.
// It ignores min_version / max_version on the request: negotiation is the
// host's job, and the guest's answer doesn't depend on who is asking.
func (h *Handler) handleHello(_ *HelloRequest) *HelloResponse {
	return &HelloResponse{
		ProtocolVersion:      ProtocolVersion,
		MinCompatibleVersion: MinCompatibleVersion,
		GuestAgentVersion:    GuestAgentVersion,
		Capabilities:         CurrentCapabilities(),
	}
}

func unmarshalParams(raw json.RawMessage, dst any) error {
	if len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		return fmt.Errorf("invalid params: %w", err)
	}
	return nil
}

// --- Method implementations ---

func (h *Handler) handlePing() *PingResponse {
	return &PingResponse{Pong: true}
}

func (h *Handler) handleReady() *ReadyResponse {
	h.ready.Store(true)
	return &ReadyResponse{Ready: true}
}

func (h *Handler) handleEnsureUser(_ context.Context, req *EnsureUserRequest) (*EnsureUserResponse, error) {
	if req.Username == "" {
		return nil, fmt.Errorf("username is required")
	}

	// Check if user already exists.
	u, err := guestLookupUser(req.Username)
	if err == nil {
		uid, _ := strconv.ParseInt(u.Uid, 10, 32)
		return &EnsureUserResponse{
			Created: false,
			UID:     int32(uid),
			Home:    u.HomeDir,
		}, nil
	}

	// Build useradd command.
	args := []string{"-m"} // create home directory
	if req.Shell != "" {
		args = append(args, "-s", req.Shell)
	} else {
		args = append(args, "-s", "/bin/bash")
	}
	if req.Home != "" {
		args = append(args, "-d", req.Home)
	}
	if req.UID != nil {
		args = append(args, "-u", strconv.FormatInt(int64(*req.UID), 10))
	}
	if len(req.Groups) > 0 {
		args = append(args, "-G", strings.Join(req.Groups, ","))
	}
	args = append(args, req.Username)

	cmd := exec.Command("useradd", args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("useradd failed: %s: %w", strings.TrimSpace(string(out)), err)
	}

	// Look up the created user.
	u, err = guestLookupUser(req.Username)
	if err != nil {
		return nil, fmt.Errorf("lookup user after creation: %w", err)
	}

	uid, _ := strconv.ParseInt(u.Uid, 10, 32)
	return &EnsureUserResponse{
		Created: true,
		UID:     int32(uid),
		Home:    u.HomeDir,
	}, nil
}

func (h *Handler) handleExec(ctx context.Context, req *ExecRequest) (*ExecResponse, error) {
	if len(req.Command) == 0 {
		return nil, fmt.Errorf("command is required")
	}

	// Bound the command's lifetime: without a deadline, a command outliving
	// the caller (host timeout, disconnect) would run until the whole agent
	// shuts down.
	timeout := defaultExecTimeout
	if req.TimeoutSec > 0 {
		timeout = time.Duration(req.TimeoutSec) * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, req.Command[0], req.Command[1:]...)

	// Set up user switching if requested.
	if req.User != "" {
		u, err := guestLookupUser(req.User)
		if err != nil {
			return nil, fmt.Errorf("lookup user %q: %w", req.User, err)
		}
		uid, _ := strconv.ParseUint(u.Uid, 10, 32)
		gid, _ := strconv.ParseUint(u.Gid, 10, 32)
		cmd.SysProcAttr = &syscall.SysProcAttr{
			Credential: &syscall.Credential{
				Uid: uint32(uid),
				Gid: uint32(gid),
			},
		}
		// Seed from the base environment (PATH etc.) and override HOME/USER
		// for the target user; exec.Cmd keeps the last duplicate entry.
		cmd.Env = append(os.Environ(), "HOME="+u.HomeDir, "USER="+u.Username)
	}

	if req.Workdir != "" {
		cmd.Dir = req.Workdir
	}

	// Merge environment variables.
	if len(cmd.Env) == 0 {
		cmd.Env = os.Environ()
	}
	for k, v := range req.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}

	if req.Stdin != "" {
		cmd.Stdin = strings.NewReader(req.Stdin)
	}

	// Run the command in its own process group and kill the whole group on
	// cancellation, so grandchildren cannot outlive the request either.
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
	cmd.Cancel = func() error {
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	// Don't let Wait block forever on pipes held open by orphaned
	// grandchildren that survived the group kill.
	cmd.WaitDelay = 5 * time.Second

	stdout := &cappedBuffer{max: maxExecOutputBytes}
	stderr := &cappedBuffer{max: maxExecOutputBytes}
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	err := cmd.Run()

	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, fmt.Errorf("exec canceled: %w", ctxErr)
	}

	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			return nil, fmt.Errorf("exec failed: %w", err)
		}
	}

	return &ExecResponse{
		ExitCode:        exitCode,
		Stdout:          stdout.buf.String(),
		Stderr:          stderr.buf.String(),
		StdoutTruncated: stdout.truncated,
		StderrTruncated: stderr.truncated,
	}, nil
}

func (h *Handler) handleWriteFile(req *WriteFileRequest) (*WriteFileResponse, error) {
	if req.Path == "" {
		return nil, fmt.Errorf("path is required")
	}

	dir := filepath.Dir(req.Path)
	if err := guestMkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create parent directory: %w", err)
	}

	mode := os.FileMode(0o644)
	if req.Mode != 0 {
		mode = os.FileMode(req.Mode)
	}

	// Atomic write: temp file -> fsync -> rename.
	tmp, err := guestCreateTemp(dir, ".guest-write-*")
	if err != nil {
		return nil, fmt.Errorf("create temp file: %w", err)
	}
	tmpName := tmp.Name()

	n, err := tmp.Write(req.Content)
	if err != nil {
		_ = tmp.Close()
		_ = guestRemove(tmpName)
		return nil, fmt.Errorf("write temp file: %w", err)
	}

	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		_ = guestRemove(tmpName)
		return nil, fmt.Errorf("fsync temp file: %w", err)
	}

	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		_ = guestRemove(tmpName)
		return nil, fmt.Errorf("chmod temp file: %w", err)
	}

	if err := tmp.Close(); err != nil {
		_ = guestRemove(tmpName)
		return nil, fmt.Errorf("close temp file: %w", err)
	}

	// Chown if requested.
	if req.OwnerUser != "" || req.OwnerGroup != "" {
		uid := -1
		gid := -1
		if req.OwnerUser != "" {
			u, err := guestLookupUser(req.OwnerUser)
			if err != nil {
				_ = guestRemove(tmpName)
				return nil, fmt.Errorf("lookup owner user %q: %w", req.OwnerUser, err)
			}
			uid64, _ := strconv.ParseInt(u.Uid, 10, 32)
			uid = int(uid64)
		}
		if req.OwnerGroup != "" {
			g, err := guestLookupGroup(req.OwnerGroup)
			if err != nil {
				_ = guestRemove(tmpName)
				return nil, fmt.Errorf("lookup owner group %q: %w", req.OwnerGroup, err)
			}
			gid64, _ := strconv.ParseInt(g.Gid, 10, 32)
			gid = int(gid64)
		}
		if err := guestChown(tmpName, uid, gid); err != nil {
			_ = guestRemove(tmpName)
			return nil, fmt.Errorf("chown temp file: %w", err)
		}
	}

	if err := guestRename(tmpName, req.Path); err != nil {
		_ = guestRemove(tmpName)
		return nil, fmt.Errorf("rename temp to target: %w", err)
	}

	return &WriteFileResponse{BytesWritten: n}, nil
}

func (h *Handler) handleReadFile(req *ReadFileRequest) (*ReadFileResponse, error) {
	if req.Path == "" {
		return nil, fmt.Errorf("path is required")
	}

	f, err := os.Open(req.Path)
	if err != nil {
		return nil, fmt.Errorf("read file: %w", err)
	}
	defer func() { _ = f.Close() }()

	// Read through a limit rather than trusting a stat size: special files
	// (procfs, pipes) report sizes that don't match their content, and the
	// response must stay well under the wire frame cap.
	data, err := io.ReadAll(io.LimitReader(f, maxReadFileBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read file: %w", err)
	}
	if len(data) > maxReadFileBytes {
		return nil, fmt.Errorf("file %s exceeds the %d byte read limit", req.Path, maxReadFileBytes)
	}

	return &ReadFileResponse{
		Content: data,
		Size:    int64(len(data)),
	}, nil
}

func (h *Handler) handleDeleteFile(req *DeleteFileRequest) (*DeleteFileResponse, error) {
	if req.Path == "" {
		return nil, fmt.Errorf("path is required")
	}

	err := os.Remove(req.Path)
	if err != nil {
		if os.IsNotExist(err) {
			return &DeleteFileResponse{Deleted: false}, nil
		}
		return nil, fmt.Errorf("delete file: %w", err)
	}

	return &DeleteFileResponse{Deleted: true}, nil
}

func (h *Handler) handleCreateTransientUnit(ctx context.Context, req *CreateTransientUnitRequest) (*CreateTransientUnitResponse, error) {
	if req.Name == "" || len(req.Exec) == 0 {
		return nil, fmt.Errorf("name and exec are required")
	}
	if err := (sandbox.ServiceSpec{Exec: req.Exec}).ValidateExec(); err != nil {
		return nil, err
	}

	unitName := req.Name
	if !strings.HasSuffix(unitName, ".service") {
		unitName += ".service"
	}

	// Build systemd-run arguments for a transient unit.
	args := []string{
		"--unit=" + unitName,
		"--remain-after-exit",
	}

	if req.User != "" {
		args = append(args, "--uid="+req.User)
	}
	if req.Group != "" {
		args = append(args, "--gid="+req.Group)
	}
	if req.Workdir != "" {
		args = append(args, "--working-directory="+req.Workdir)
	}

	for k, v := range req.Env {
		args = append(args, "--setenv="+k+"="+v)
	}

	if req.Mode == UnitModeOneshot {
		args = append(args, "--property=Type=oneshot")
	}

	if req.RestartPolicy != nil {
		args = append(args, "--property=Restart="+req.RestartPolicy.Kind)
		if req.RestartPolicy.Sec != nil {
			args = append(args, fmt.Sprintf("--property=RestartSec=%d", *req.RestartPolicy.Sec))
		}
	}

	if req.TimeoutSec != nil {
		args = append(args, fmt.Sprintf("--property=TimeoutStartSec=%d", *req.TimeoutSec))
	}

	for _, after := range req.After {
		args = append(args, "--property=After="+after)
	}
	for _, requires := range req.Requires {
		args = append(args, "--property=Requires="+requires)
	}

	// Append the actual command to run.
	args = append(args, "--")
	for _, arg := range req.Exec {
		args = append(args, strings.ReplaceAll(arg, "$", "$$"))
	}

	cmd := exec.CommandContext(ctx, "systemd-run", args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("systemd-run failed: %s: %w", strings.TrimSpace(string(out)), err)
	}

	return &CreateTransientUnitResponse{
		UnitName: unitName,
		Started:  true,
	}, nil
}

// validateUnitField rejects values that would break out of their intended
// directive when written into a systemd unit file. A unit file is line-based,
// so any newline or carriage return in a user-supplied value lets a caller
// inject arbitrary directives (or even new sections) into the generated unit.
// Other ASCII control characters have no legitimate place in these fields and
// are rejected defensively. The field name is included in the error so the RPC
// caller can tell which value was bad.
func validateUnitField(field, value string) error {
	for _, r := range value {
		if r == '\n' || r == '\r' {
			return fmt.Errorf("%s contains a newline character", field)
		}
		// Reject C0 control characters (and DEL); printable values only.
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("%s contains a control character (0x%02x)", field, r)
		}
	}
	return nil
}

func (h *Handler) handleCreatePersistentUnit(ctx context.Context, req *CreatePersistentUnitRequest) (*CreatePersistentUnitResponse, error) {
	if req.Name == "" || len(req.Exec) == 0 {
		return nil, fmt.Errorf("name and exec are required")
	}
	if err := (sandbox.ServiceSpec{Exec: req.Exec}).ValidateExec(); err != nil {
		return nil, err
	}

	// Reject control-character / newline injection in every value that gets
	// concatenated into the unit file. Without this, a newline smuggles
	// arbitrary systemd directives past the structured builder below.
	if err := validateUnitField("name", req.Name); err != nil {
		return nil, err
	}
	for i, v := range req.After {
		if err := validateUnitField(fmt.Sprintf("after[%d]", i), v); err != nil {
			return nil, err
		}
	}
	for i, v := range req.Requires {
		if err := validateUnitField(fmt.Sprintf("requires[%d]", i), v); err != nil {
			return nil, err
		}
	}

	if err := validateUnitField("user", req.User); err != nil {
		return nil, err
	}
	if err := validateUnitField("group", req.Group); err != nil {
		return nil, err
	}
	if err := validateUnitField("workdir", req.Workdir); err != nil {
		return nil, err
	}
	for k, v := range req.Env {
		if err := validateUnitField("env key", k); err != nil {
			return nil, err
		}
		if err := validateUnitField(fmt.Sprintf("env[%s]", k), v); err != nil {
			return nil, err
		}
	}
	if req.RestartPolicy != nil {
		if err := validateUnitField("restart policy kind", req.RestartPolicy.Kind); err != nil {
			return nil, err
		}
	}
	for i, v := range req.WantedBy {
		if err := validateUnitField(fmt.Sprintf("wanted_by[%d]", i), v); err != nil {
			return nil, err
		}
	}

	unitName := req.Name
	if !strings.HasSuffix(unitName, ".service") {
		unitName += ".service"
	}

	// Build the unit file content.
	var buf strings.Builder
	buf.WriteString("[Unit]\n")
	buf.WriteString(fmt.Sprintf("Description=%s\n", unitName))
	if len(req.After) > 0 {
		buf.WriteString(fmt.Sprintf("After=%s\n", strings.Join(req.After, " ")))
	}
	if len(req.Requires) > 0 {
		buf.WriteString(fmt.Sprintf("Requires=%s\n", strings.Join(req.Requires, " ")))
	}
	buf.WriteString("\n[Service]\n")

	switch req.Mode {
	case UnitModeOneshot:
		buf.WriteString("Type=oneshot\n")
		buf.WriteString("RemainAfterExit=yes\n")
	default:
		buf.WriteString("Type=simple\n")
	}

	buf.WriteString(fmt.Sprintf("ExecStart=%s\n", systemdExecLine(req.Exec)))

	if req.User != "" {
		buf.WriteString(fmt.Sprintf("User=%s\n", req.User))
	}
	if req.Group != "" {
		buf.WriteString(fmt.Sprintf("Group=%s\n", req.Group))
	}
	if req.Workdir != "" {
		buf.WriteString(fmt.Sprintf("WorkingDirectory=%s\n", req.Workdir))
	}

	for k, v := range req.Env {
		buf.WriteString(fmt.Sprintf("Environment=%s=%s\n", k, v))
	}

	if req.RestartPolicy != nil {
		buf.WriteString(fmt.Sprintf("Restart=%s\n", req.RestartPolicy.Kind))
		if req.RestartPolicy.Sec != nil {
			buf.WriteString(fmt.Sprintf("RestartSec=%d\n", *req.RestartPolicy.Sec))
		}
	}

	if req.TimeoutSec != nil {
		buf.WriteString(fmt.Sprintf("TimeoutStartSec=%d\n", *req.TimeoutSec))
	}

	wantedBy := req.WantedBy
	if len(wantedBy) == 0 {
		wantedBy = []string{"multi-user.target"}
	}
	buf.WriteString("\n[Install]\n")
	buf.WriteString(fmt.Sprintf("WantedBy=%s\n", strings.Join(wantedBy, " ")))

	// Write the unit file atomically. Root-only (0600): Environment= lines
	// can carry secrets (agent tokens, API keys) and must not be readable by
	// other users in the VM; systemd reads unit files as root.
	unitPath := filepath.Join(guestSystemdUnitPath, unitName)
	writeReq := &WriteFileRequest{
		Path:    unitPath,
		Content: []byte(buf.String()),
		Mode:    0o600,
	}
	if _, err := h.handleWriteFile(writeReq); err != nil {
		return nil, fmt.Errorf("write unit file: %w", err)
	}

	// Reload systemd daemon.
	if out, err := exec.CommandContext(ctx, "systemctl", "daemon-reload").CombinedOutput(); err != nil {
		return nil, fmt.Errorf("daemon-reload failed: %s: %w", strings.TrimSpace(string(out)), err)
	}

	enabled := false
	if req.Enable {
		if out, err := exec.CommandContext(ctx, "systemctl", "enable", unitName).CombinedOutput(); err != nil {
			return nil, fmt.Errorf("enable unit failed: %s: %w", strings.TrimSpace(string(out)), err)
		}
		enabled = true
	}

	// Start the unit.
	if out, err := exec.CommandContext(ctx, "systemctl", "start", unitName).CombinedOutput(); err != nil {
		return nil, fmt.Errorf("start unit failed: %s: %w", strings.TrimSpace(string(out)), err)
	}

	return &CreatePersistentUnitResponse{
		UnitName: unitName,
		Enabled:  enabled,
		Started:  true,
	}, nil
}

func (h *Handler) handleRestartUnit(ctx context.Context, req *RestartUnitRequest) (*RestartUnitResponse, error) {
	if req.Name == "" {
		return nil, fmt.Errorf("name is required")
	}

	unitName := req.Name
	if !strings.HasSuffix(unitName, ".service") && !strings.HasSuffix(unitName, ".timer") && !strings.HasSuffix(unitName, ".socket") {
		unitName += ".service"
	}

	if out, err := exec.CommandContext(ctx, "systemctl", "restart", unitName).CombinedOutput(); err != nil {
		return nil, fmt.Errorf("restart unit failed: %s: %w", strings.TrimSpace(string(out)), err)
	}

	return &RestartUnitResponse{Restarted: true}, nil
}

func (h *Handler) handleUnitStatus(ctx context.Context, req *UnitStatusRequest) (*UnitStatusResponse, error) {
	if req.Name == "" {
		return nil, fmt.Errorf("name is required")
	}

	unitName := req.Name
	if !strings.HasSuffix(unitName, ".service") && !strings.HasSuffix(unitName, ".timer") && !strings.HasSuffix(unitName, ".socket") {
		unitName += ".service"
	}

	// Use systemctl show to get machine-readable properties.
	cmd := exec.CommandContext(ctx, "systemctl", "show", unitName,
		"--property=LoadState,ActiveState,SubState,Description",
		"--no-pager")
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("systemctl show failed: %w", err)
	}

	resp := &UnitStatusResponse{Name: unitName}
	for _, line := range strings.Split(string(out), "\n") {
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		val := strings.TrimSpace(parts[1])
		switch key {
		case "LoadState":
			resp.LoadState = val
		case "ActiveState":
			resp.ActiveState = val
		case "SubState":
			resp.SubState = val
		case "Description":
			resp.Description = val
		}
	}

	return resp, nil
}

func (h *Handler) handleTailJournal(ctx context.Context, req *TailJournalRequest) (*TailJournalResponse, error) {
	if req.Unit == "" {
		return nil, fmt.Errorf("unit is required")
	}

	lines := req.Lines
	if lines <= 0 {
		lines = 100
	}
	if lines > maxTailJournalLines {
		lines = maxTailJournalLines
	}

	args := []string{
		"-u", req.Unit,
		"-n", strconv.Itoa(lines),
		"--no-pager",
		"-o", "short-iso",
	}

	cmd := exec.CommandContext(ctx, "journalctl", args...)
	out := &cappedBuffer{max: maxTailJournalBytes}
	cmd.Stdout = out
	if err := cmd.Run(); err != nil {
		// journalctl returns 1 if the unit has no entries, which is fine.
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return &TailJournalResponse{Lines: []string{}}, nil
		}
		return nil, fmt.Errorf("journalctl failed: %w", err)
	}

	outputLines := strings.Split(strings.TrimSpace(out.buf.String()), "\n")
	if len(outputLines) == 1 && outputLines[0] == "" {
		outputLines = []string{}
	}
	if out.truncated && len(outputLines) > 0 {
		// The byte cap can cut the final line mid-way; drop it rather than
		// returning a mangled entry.
		outputLines = outputLines[:len(outputLines)-1]
	}

	return &TailJournalResponse{
		Lines:     outputLines,
		More:      false,
		Truncated: out.truncated,
	}, nil
}

func (h *Handler) handlePrepareSnapshot(ctx context.Context) (*PrepareSnapshotResponse, error) {
	slog.Info("preparing for snapshot: syncing filesystems")

	// Sync all filesystems.
	if out, err := exec.CommandContext(ctx, "sync").CombinedOutput(); err != nil {
		return nil, fmt.Errorf("sync failed: %s: %w", strings.TrimSpace(string(out)), err)
	}

	// Drop caches to minimize dirty pages.
	_ = os.WriteFile("/proc/sys/vm/drop_caches", []byte("3"), 0o644)

	slog.Info("snapshot preparation complete")
	return &PrepareSnapshotResponse{Synced: true}, nil
}

// handlePostResume cannot fail: a missing or failing NTP client is reported as
// ClockRefreshed=false, never as an RPC error.
func (h *Handler) handlePostResume(ctx context.Context) *PostResumeResponse {
	slog.Info("post-resume: refreshing clock and state")

	// Force NTP sync if chronyc/ntpdate is available.
	clockRefreshed := false
	if _, err := exec.LookPath("chronyc"); err == nil {
		if out, err := exec.CommandContext(ctx, "chronyc", "makestep").CombinedOutput(); err != nil {
			slog.Warn("chronyc makestep failed", "error", err, "output", strings.TrimSpace(string(out)))
		} else {
			clockRefreshed = true
		}
	} else if _, err := exec.LookPath("ntpdate"); err == nil {
		if out, err := exec.CommandContext(ctx, "ntpdate", "-b", "-u", "pool.ntp.org").CombinedOutput(); err != nil {
			slog.Warn("ntpdate failed", "error", err, "output", strings.TrimSpace(string(out)))
		} else {
			clockRefreshed = true
		}
	} else {
		slog.Warn("no NTP client available for clock refresh")
	}

	// Reset the idle timer so a freshly-resumed VM gets full idle budget.
	h.touchActivity()

	slog.Info("post-resume complete", "clock_refreshed", clockRefreshed)
	return &PostResumeResponse{ClockRefreshed: clockRefreshed}
}

// handleEmitApprovalRequest validates the request payload and returns an
// acknowledgement (ticket 0110). The guest side does NOT persist the
// approval — it only performs shape validation so the host forwarder can
// trust the envelope. Smithers is the source of truth for the approvals table.
//
// Validation rules (cheap, local, fail-fast):
//   - session_id, kind, title are required non-empty strings.
//   - kind and title have hard length caps so a runaway runtime can't
//     spam huge payloads.
//   - payload, if present, must parse as valid JSON and fit under the
//     envelope-side cap; Smithers enforces the persisted-size cap again.
//
// No PII is logged here: session_id is the only identifier and is not PII.
func (h *Handler) handleEmitApprovalRequest(req *EmitApprovalRequestRequest) (*EmitApprovalRequestResponse, error) {
	if strings.TrimSpace(req.SessionID) == "" {
		return nil, fmt.Errorf("session_id is required")
	}
	if strings.TrimSpace(req.Kind) == "" {
		return nil, fmt.Errorf("kind is required")
	}
	if strings.TrimSpace(req.Title) == "" {
		return nil, fmt.Errorf("title is required")
	}
	// Defensive caps; Smithers re-validates.
	if len(req.Kind) > 64 {
		return nil, fmt.Errorf("kind exceeds 64 bytes")
	}
	if len(req.Title) > 512 {
		return nil, fmt.Errorf("title exceeds 512 bytes")
	}
	if len(req.Description) > 4096 {
		return nil, fmt.Errorf("description exceeds 4096 bytes")
	}
	// 256 KiB payload cap matches the Smithers service-layer limit.
	const maxPayloadBytes = 256 * 1024
	if len(req.Payload) > maxPayloadBytes {
		return nil, fmt.Errorf("payload exceeds %d bytes", maxPayloadBytes)
	}
	if len(req.Payload) > 0 {
		if !json.Valid(req.Payload) {
			return nil, fmt.Errorf("payload is not valid JSON")
		}
	}
	// expires_at, if present, must be RFC3339. Best-effort parse; caller
	// bugs fail closed.
	if req.ExpiresAt != "" {
		if _, err := time.Parse(time.RFC3339, req.ExpiresAt); err != nil {
			return nil, fmt.Errorf("expires_at is not RFC3339: %w", err)
		}
	}

	slog.Info("approval request emitted",
		"session_id", req.SessionID,
		"kind", req.Kind,
	)
	return &EmitApprovalRequestResponse{Accepted: true}, nil
}

// validDevtoolsSnapshotKinds mirrors the closed enum enforced by
// internal/services/devtools.go and the CHECK constraint in
// db/product/migrations/0001_product_baseline.sql. The guest keeps its own
// copy so it can fail-fast before putting a bad envelope on the wire; Smithers
// re-validates authoritatively.
var validDevtoolsSnapshotKinds = map[string]struct{}{
	"file_tree":      {},
	"screenshot":     {},
	"command_output": {},
	"tool_state":     {},
}

// handleWriteDevtoolsSnapshot validates the request payload and returns an
// acknowledgement (ticket 0107). The guest side does NOT persist the
// snapshot — it only performs shape validation so the host forwarder can
// trust the envelope. Smithers is the source of truth for the
// devtools_snapshots table and derives repository_id from session context.
//
// Validation rules (cheap, local, fail-fast):
//   - session_id is required non-empty.
//   - kind must be in the closed enum (file_tree / screenshot /
//     command_output / tool_state).
//   - payload, if present, must parse as valid JSON AND be an object
//     (Smithers's jsonb_typeof = 'object' CHECK constraint would catch this
//     eventually; the guest catches it up-front for a clean error surface).
//   - payload size capped at 256 KiB — same cap as Smithers's service layer
//     and the approvals handler. Larger payloads (screenshots) must be
//     uploaded to blob storage by the caller and referenced by URL.
//
// No PII is logged: session_id and kind are the only identifiers and
// neither is PII.
func (h *Handler) handleWriteDevtoolsSnapshot(req *WriteDevtoolsSnapshotRequest) (*WriteDevtoolsSnapshotResponse, error) {
	if strings.TrimSpace(req.SessionID) == "" {
		return nil, fmt.Errorf("session_id is required")
	}
	if strings.TrimSpace(req.Kind) == "" {
		return nil, fmt.Errorf("kind is required")
	}
	if _, ok := validDevtoolsSnapshotKinds[req.Kind]; !ok {
		return nil, fmt.Errorf("kind %q is not in the allowed enum", req.Kind)
	}
	// 256 KiB payload cap matches the Smithers service-layer limit
	// (MaxDevtoolsPayloadBytes in internal/services/devtools.go).
	const maxPayloadBytes = 256 * 1024
	if len(req.Payload) > maxPayloadBytes {
		return nil, fmt.Errorf("payload exceeds %d bytes", maxPayloadBytes)
	}
	if len(req.Payload) > 0 {
		if !json.Valid(req.Payload) {
			return nil, fmt.Errorf("payload is not valid JSON")
		}
		// Must be a JSON object (not array / scalar). Mirrors the DB's
		// jsonb_typeof = 'object' CHECK so the error surface is
		// consistent between guest-side and server-side rejection.
		var probe any
		if err := json.Unmarshal(req.Payload, &probe); err != nil {
			return nil, fmt.Errorf("payload is not valid JSON: %w", err)
		}
		if _, ok := probe.(map[string]any); !ok {
			return nil, fmt.Errorf("payload must be a JSON object")
		}
	}

	slog.Info("devtools snapshot emitted",
		"session_id", req.SessionID,
		"kind", req.Kind,
		"payload_bytes", len(req.Payload),
	)
	return &WriteDevtoolsSnapshotResponse{Accepted: true}, nil
}
