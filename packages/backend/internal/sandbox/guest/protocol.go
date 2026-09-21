// Package guest implements the guest-side agent that runs inside a sandbox
// VM and handles RPC requests from the host agent over vsock.
package guest

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"time"
)

// VsockPort is the well-known vsock port the guest agent listens on.
const VsockPort = 10777

// Method names for the RPC protocol.
const (
	// MethodHello is the capability-negotiation handshake. The host issues
	// this first on each connection to discover the guest's protocol version
	// and advertised capabilities. Older guests that predate this method
	// respond with an unknown-method error; see LegacyProtocolVersion and
	// LegacyCapabilities for the bootstrap fallback contract.
	MethodHello = "Hello"

	// MethodAuthenticate presents the per-VM control-plane token. When the
	// guest agent is started with an auth token, this MUST be the first
	// request on every connection; every other method (including Hello) is
	// rejected with ErrorCodeUnauthenticated until it succeeds. It is handled
	// by the connection loop in cmd/guest-agent (per-connection state), never
	// by Handler.HandleRequest.
	MethodAuthenticate = "Authenticate"

	MethodPing                 = "Ping"
	MethodReady                = "Ready"
	MethodEnsureUser           = "EnsureUser"
	MethodExec                 = "Exec"
	MethodWriteFile            = "WriteFile"
	MethodReadFile             = "ReadFile"
	MethodDeleteFile           = "DeleteFile"
	MethodCreateTransientUnit  = "CreateTransientUnit"
	MethodCreatePersistentUnit = "CreatePersistentUnit"
	MethodRestartUnit          = "RestartUnit"
	MethodUnitStatus           = "UnitStatus"
	MethodTailJournal          = "TailJournal"
	MethodPrepareSnapshot      = "PrepareSnapshot"
	MethodPostResume           = "PostResume"

	// MethodEmitApprovalRequest is sent from the guest agent runtime to
	// the host when it needs human approval before taking a sensitive
	// action (ticket 0110). Gated by CapabilityApprovalsEmit: the host
	// MUST verify the capability has been advertised by the negotiated
	// guest before invoking this method. The guest's Handler only
	// acknowledges receipt and echoes an ID; the host is responsible for
	// forwarding the emission upstream (to Smithers, which persists the row).
	MethodEmitApprovalRequest = "EmitApprovalRequest"

	// MethodWriteDevtoolsSnapshot is sent from the guest agent runtime to
	// the host when it produces a new snapshot of agent context (ticket
	// 0107). Gated by CapabilityDevtoolsSnapshotsWrite: the host MUST
	// verify the capability has been advertised by the negotiated guest
	// before invoking this method. The guest handler validates payload
	// shape (kind in enum, payload is a valid JSON object, size cap) and
	// acknowledges receipt; Smithers is the source of truth for the
	// devtools_snapshots table and derives repository_id from session
	// context.
	MethodWriteDevtoolsSnapshot = "WriteDevtoolsSnapshot"
)

// Protocol version constants.
//
// ProtocolVersion is the current wire version advertised by this build of the
// guest agent. Bump when introducing a change that the host's capability
// check cannot fully describe on its own (e.g. a framing change). Additive
// method additions should be expressed as new entries in capabilities
// instead, so rollouts can happen independently.
const (
	// ProtocolVersion is the version advertised by the current guest build.
	ProtocolVersion = 2

	// MinCompatibleVersion is the oldest protocol version this guest build
	// can still speak when talking to an older host.
	MinCompatibleVersion = 1

	// LegacyProtocolVersion is what the host records when talking to a guest
	// that does not implement MethodHello.
	LegacyProtocolVersion = 1
)

// GuestAgentVersion is a build-identifier string for the running guest
// agent. It is not used for compatibility decisions (capabilities are the
// source of truth); it only helps diagnostics. The build pipeline can stamp
// this via -ldflags at link time; default here matches the source tree.
var GuestAgentVersion = "dev"

// Capability names. All optional or rollout-gated functionality added after
// ticket 0131 must be keyed off a string capability rather than a version
// integer. This lets 0107 and 0110 ship independently.
const (
	// CapabilityDevtoolsSnapshotsWrite advertises that the guest implements
	// the devtools snapshot writer method (ticket 0107). NOT advertised by
	// CurrentCapabilities yet: the guest handler only validates and ACKs the
	// envelope; no host-side forwarder persists the snapshot through
	// internal/services/devtools.go. Advertising it before that path exists
	// would make hosts treat a local-only ACK as durable persistence.
	// Add it back to CurrentCapabilities in the ticket that ships the
	// forwarder.
	CapabilityDevtoolsSnapshotsWrite = "devtools_snapshots.write"

	// CapabilityApprovalsEmit advertises that the guest implements the
	// approvals emission method (ticket 0110). NOT advertised yet for the
	// same reason as CapabilityDevtoolsSnapshotsWrite: without a forwarder
	// into internal/services/approvals.go, an ACKed emission would silently
	// bypass the human-approval gate.
	CapabilityApprovalsEmit = "approvals.emit"
)

// LegacyCapabilities is the fixed capability set the host assumes when
// talking to a guest that does not implement MethodHello. It covers exactly
// the method set that shipped before ticket 0131 and MUST NOT grow.
//
// DELETION CRITERION: remove LegacyCapabilities and the associated fallback
// branch in the host client once every sandbox image in production speaks
// MethodHello. At that point the Hello probe can fail hard on unknown-method
// responses instead of synthesizing a capability set.
var LegacyCapabilities = []string{
	MethodPing,
	MethodReady,
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
	MethodPrepareSnapshot,
	MethodPostResume,
}

// CurrentCapabilities returns the capability set advertised by this build of
// the guest agent. Every legacy method name is included so the host can gate
// every method uniformly off capabilities. New capability constants are added
// here by the ticket that ships the capability END TO END — a capability is a
// promise about the full emission path, not just the guest-local handler.
// CapabilityApprovalsEmit and CapabilityDevtoolsSnapshotsWrite are
// intentionally absent: their guest handlers exist (validation + ACK), but no
// host forwarder persists the emissions to Smithers yet, so advertising them
// would let a runtime believe an approval/snapshot was queued when it was
// dropped.
func CurrentCapabilities() []string {
	caps := make([]string, 0, len(LegacyCapabilities))
	caps = append(caps, LegacyCapabilities...)
	return caps
}

// Structured error codes returned on Response.ErrorCode. New guests populate
// these; old guests only populate Response.Error (a free-form string).
const (
	// ErrorCodeUnknownMethod signals that the guest does not recognize the
	// requested method. Hosts treat this as a capability-absent signal.
	ErrorCodeUnknownMethod = "unknown_method"

	// ErrorCodeUnsupportedCapability signals that a gated capability is
	// not available in this build.
	ErrorCodeUnsupportedCapability = "unsupported_capability"

	// ErrorCodeInvalidParams signals malformed method parameters.
	ErrorCodeInvalidParams = "invalid_params"

	// ErrorCodeInternal is the catch-all for handler-level failures.
	ErrorCodeInternal = "internal"

	// ErrorCodeUnauthenticated signals that the connection has not presented
	// the required control-plane token via MethodAuthenticate. The guest
	// closes the connection after sending this.
	ErrorCodeUnauthenticated = "unauthenticated"
)

// maxMessageSize prevents a single message from consuming unbounded memory.
const maxMessageSize = 64 << 20 // 64 MiB

// Request is the top-level envelope sent from host to guest.
type Request struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

// Response is the top-level envelope sent from guest to host.
//
// It is deliberately NOT pkg/errors.APIError, and its {error, error_code} pair
// is not a second spelling of {message, code} on the API. This is a private
// RPC between two plue components over vsock (see VsockPort above): the only
// writer is cmd/guest-agent inside the VM, the only reader is
// internal/sandbox/guest.Client on the host, no HTTP client ever sees these
// bytes, and ErrorCode's values are capability-negotiation signals
// (unknown_method, unsupported_capability) rather than failure verdicts a user
// could act on. A host that decides a guest failure should reach a user
// translates it there, into a registered pkg/errors code. Do not "unify" this
// shape: it would put the guest's own words on the wire and couple a
// cross-version socket protocol to the public failure taxonomy.
//
// Backward compatibility: old guests only populate Error (free-form string).
// New guests additionally populate ErrorCode with one of the ErrorCode*
// constants. The host uses ErrorCode when present and falls back to a narrow
// prefix match on Error only for the bootstrap MethodHello probe; see
// protocol.go LegacyCapabilities for the deletion criterion.
type Response struct {
	ID    string `json:"id"`
	Error string `json:"error,omitempty"`
	// ErrorCode is the structured, machine-readable error classifier. Empty
	// on success or when produced by a guest that predates this field.
	ErrorCode string `json:"error_code,omitempty"`
	// Result holds the method-specific response payload. Nil on error-only
	// responses.
	Result json.RawMessage `json:"result,omitempty"`
}

// --- Per-method request/response types ---

// HelloRequest is the body of a Hello RPC. All fields are optional; a guest
// that cannot satisfy the requested range should still reply with its own
// supported range so the host can decide how to proceed.
type HelloRequest struct {
	// MinVersion is the oldest protocol version the host can still speak.
	// Zero means "host does not care; tell me what you've got."
	MinVersion int `json:"min_version,omitempty"`
	// MaxVersion is the newest protocol version the host supports.
	MaxVersion int `json:"max_version,omitempty"`
}

// HelloResponse is returned from Hello. It is the source of truth for
// capability gating: the host keys optional behavior off Capabilities, not
// ProtocolVersion.
type HelloResponse struct {
	ProtocolVersion      int      `json:"protocol_version"`
	MinCompatibleVersion int      `json:"min_compatible_version"`
	GuestAgentVersion    string   `json:"guest_agent_version"`
	Capabilities         []string `json:"capabilities"`
}

// PingRequest is the body of a Ping RPC (empty).
type PingRequest struct{}

// PingResponse is returned from Ping.
type PingResponse struct {
	Pong bool `json:"pong"`
}

// ReadyRequest is the body of a Ready RPC (empty).
type ReadyRequest struct{}

// ReadyResponse is returned from Ready.
type ReadyResponse struct {
	Ready bool `json:"ready"`
}

// EnsureUserRequest creates or configures a Linux user.
type EnsureUserRequest struct {
	Username string   `json:"username"`
	UID      *int32   `json:"uid,omitempty"`
	Groups   []string `json:"groups,omitempty"`
	Home     string   `json:"home,omitempty"`
	Shell    string   `json:"shell,omitempty"`
}

// EnsureUserResponse is returned from EnsureUser.
type EnsureUserResponse struct {
	Created bool   `json:"created"`
	UID     int32  `json:"uid"`
	Home    string `json:"home"`
}

// ExecRequest runs a command inside the guest.
type ExecRequest struct {
	Command []string          `json:"command"`
	User    string            `json:"user,omitempty"`
	Workdir string            `json:"workdir,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	Stdin   string            `json:"stdin,omitempty"`
	// TimeoutSec bounds the command's runtime. Zero or negative applies the
	// guest's server-side default; the command (and its whole process group)
	// is killed when the limit elapses.
	TimeoutSec int64 `json:"timeout_sec,omitempty"`
}

// ExecResponse is returned from Exec.
type ExecResponse struct {
	ExitCode int    `json:"exit_code"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	// StdoutTruncated / StderrTruncated report that the corresponding stream
	// exceeded the guest's per-stream capture cap and was cut off.
	StdoutTruncated bool `json:"stdout_truncated,omitempty"`
	StderrTruncated bool `json:"stderr_truncated,omitempty"`
}

// WriteFileRequest writes content to a path atomically.
type WriteFileRequest struct {
	Path       string `json:"path"`
	Content    []byte `json:"content"`
	Mode       uint32 `json:"mode,omitempty"`
	OwnerUser  string `json:"owner_user,omitempty"`
	OwnerGroup string `json:"owner_group,omitempty"`
}

// WriteFileResponse is returned from WriteFile.
type WriteFileResponse struct {
	BytesWritten int `json:"bytes_written"`
}

// ReadFileRequest reads file contents.
type ReadFileRequest struct {
	Path string `json:"path"`
}

// ReadFileResponse is returned from ReadFile.
type ReadFileResponse struct {
	Content []byte `json:"content"`
	Size    int64  `json:"size"`
}

// DeleteFileRequest deletes a file.
type DeleteFileRequest struct {
	Path string `json:"path"`
}

// DeleteFileResponse is returned from DeleteFile.
type DeleteFileResponse struct {
	Deleted bool `json:"deleted"`
}

// ServiceMode describes whether a unit is oneshot or long-running.
type ServiceMode string

const (
	UnitModeOneshot ServiceMode = "oneshot"
	UnitModeService ServiceMode = "service"
)

// RestartPolicy configures restart behavior for a unit.
type RestartPolicy struct {
	Kind string `json:"kind"` // "always", "on-failure", "no"
	Sec  *int64 `json:"sec,omitempty"`
}

// CreateTransientUnitRequest creates a transient (non-persisted) systemd unit.
type CreateTransientUnitRequest struct {
	Name          string            `json:"name"`
	Mode          ServiceMode       `json:"mode"`
	Exec          []string          `json:"exec"`
	User          string            `json:"user,omitempty"`
	Group         string            `json:"group,omitempty"`
	Env           map[string]string `json:"env,omitempty"`
	Workdir       string            `json:"workdir,omitempty"`
	After         []string          `json:"after,omitempty"`
	Requires      []string          `json:"requires,omitempty"`
	RestartPolicy *RestartPolicy    `json:"restart_policy,omitempty"`
	TimeoutSec    *int64            `json:"timeout_sec,omitempty"`
}

// CreateTransientUnitResponse is returned from CreateTransientUnit.
type CreateTransientUnitResponse struct {
	UnitName string `json:"unit_name"`
	Started  bool   `json:"started"`
}

// CreatePersistentUnitRequest creates a persistent systemd unit on disk.
type CreatePersistentUnitRequest struct {
	Name          string            `json:"name"`
	Mode          ServiceMode       `json:"mode"`
	Exec          []string          `json:"exec"`
	User          string            `json:"user,omitempty"`
	Group         string            `json:"group,omitempty"`
	Env           map[string]string `json:"env,omitempty"`
	Workdir       string            `json:"workdir,omitempty"`
	After         []string          `json:"after,omitempty"`
	Requires      []string          `json:"requires,omitempty"`
	WantedBy      []string          `json:"wanted_by,omitempty"`
	RestartPolicy *RestartPolicy    `json:"restart_policy,omitempty"`
	TimeoutSec    *int64            `json:"timeout_sec,omitempty"`
	Enable        bool              `json:"enable,omitempty"`
}

// CreatePersistentUnitResponse is returned from CreatePersistentUnit.
type CreatePersistentUnitResponse struct {
	UnitName string `json:"unit_name"`
	Enabled  bool   `json:"enabled"`
	Started  bool   `json:"started"`
}

// RestartUnitRequest restarts a systemd unit.
type RestartUnitRequest struct {
	Name string `json:"name"`
}

// RestartUnitResponse is returned from RestartUnit.
type RestartUnitResponse struct {
	Restarted bool `json:"restarted"`
}

// UnitStatusRequest queries systemd unit status.
type UnitStatusRequest struct {
	Name string `json:"name"`
}

// UnitStatusResponse is returned from UnitStatus.
type UnitStatusResponse struct {
	Name        string `json:"name"`
	LoadState   string `json:"load_state"`
	ActiveState string `json:"active_state"`
	SubState    string `json:"sub_state"`
	Description string `json:"description,omitempty"`
}

// TailJournalRequest streams journald logs for a unit.
type TailJournalRequest struct {
	Unit  string `json:"unit"`
	Lines int    `json:"lines,omitempty"`
	// Follow indicates streaming mode. If true, the response is streamed
	// as multiple length-prefixed JSON chunks until the connection closes.
	Follow bool `json:"follow,omitempty"`
}

// TailJournalResponse is returned from TailJournal (one chunk per message
// when follow=true, otherwise a single response).
type TailJournalResponse struct {
	Lines []string `json:"lines"`
	// More is true when follow=true and more lines may arrive.
	More bool `json:"more,omitempty"`
	// Truncated is true when the selected journal output exceeded the
	// guest's byte cap and was cut off.
	Truncated bool `json:"truncated,omitempty"`
}

// PrepareSnapshotRequest quiesces the guest before a snapshot.
type PrepareSnapshotRequest struct{}

// PrepareSnapshotResponse is returned from PrepareSnapshot.
type PrepareSnapshotResponse struct {
	Synced bool `json:"synced"`
}

// PostResumeRequest re-initializes guest state after a snapshot resume.
type PostResumeRequest struct{}

// PostResumeResponse is returned from PostResume.
type PostResumeResponse struct {
	ClockRefreshed bool `json:"clock_refreshed"`
}

// AuthenticateRequest is the body of an Authenticate RPC. Token is the per-VM
// control-plane credential provisioned to both the host agent and the guest
// (via the guest-agent -auth-token-file flag).
type AuthenticateRequest struct {
	Token string `json:"token"`
}

// AuthenticateResponse is returned from Authenticate. A guest with no token
// configured answers Authenticated=true so hosts can send the request
// unconditionally.
type AuthenticateResponse struct {
	Authenticated bool `json:"authenticated"`
}

// EmitApprovalRequestRequest is the body of an EmitApprovalRequest RPC
// (ticket 0110). Emitted by the guest runtime when it needs human approval
// for a sensitive action (file write, shell command, network call, etc.).
//
// session_id anchors the approval to an active agent session. kind is a
// machine-readable category the UI can branch on. title is a short
// user-facing string. description is optional longer context. payload is
// the action-specific JSON context (diff, command args, etc.) — the host
// side caps its serialized size (see internal/services/approvals.go).
// expires_at is an optional client-side filter hint; see the expiry policy
// note on ShapeApprovals.
type EmitApprovalRequestRequest struct {
	SessionID   string          `json:"session_id"`
	Kind        string          `json:"kind"`
	Title       string          `json:"title"`
	Description string          `json:"description,omitempty"`
	Payload     json.RawMessage `json:"payload,omitempty"`
	ExpiresAt   string          `json:"expires_at,omitempty"` // RFC3339; empty = no expiry
}

// EmitApprovalRequestResponse acknowledges receipt of the emission. The
// guest-side handler does not generate the persisted ID (Smithers does); the
// Accepted boolean tells the runtime its message was queued for forwarding.
type EmitApprovalRequestResponse struct {
	Accepted bool `json:"accepted"`
}

// WriteDevtoolsSnapshotRequest is the body of a WriteDevtoolsSnapshot RPC
// (ticket 0107). Emitted by the guest runtime when it produces a new
// snapshot of agent context — file tree view, screenshot, command output,
// or tool-state blob.
//
// session_id anchors the snapshot to an active agent session. kind is the
// snapshot category; the server enforces the closed enum ("file_tree",
// "screenshot", "command_output", "tool_state"). payload is the
// kind-specific JSON context. The guest validates payload shape locally
// (valid JSON object, <= 256 KiB) so the host can trust the envelope;
// Smithers re-validates and derives repository_id from the session.
//
// Note there is no repository_id on the wire: it is derived server-side
// from session_id to keep the guest outside the repository-scoping trust
// boundary.
type WriteDevtoolsSnapshotRequest struct {
	SessionID string          `json:"session_id"`
	Kind      string          `json:"kind"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

// WriteDevtoolsSnapshotResponse acknowledges receipt of the snapshot. The
// guest-side handler does not persist the row; Smithers does. The Accepted
// boolean tells the runtime its snapshot was queued for forwarding.
type WriteDevtoolsSnapshotResponse struct {
	Accepted bool `json:"accepted"`
}

// --- Wire helpers ---

// WriteMessage writes a length-prefixed JSON message to w.
// Format: [4-byte big-endian length][JSON payload]
func WriteMessage(w io.Writer, msg any) error {
	payload, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("marshal message: %w", err)
	}

	length := uint32(len(payload))
	if err := binary.Write(w, binary.BigEndian, length); err != nil {
		return fmt.Errorf("write message length: %w", err)
	}

	if _, err := w.Write(payload); err != nil {
		return fmt.Errorf("write message payload: %w", err)
	}

	return nil
}

// ReadMessage reads a length-prefixed JSON message from r and unmarshals into
// msg.
func ReadMessage(r io.Reader, msg any) error {
	return readMessage(r, msg, nil)
}

// ReadMessageConn is ReadMessage for a server-side connection: it waits for
// the length prefix without a deadline (connections legitimately sit idle
// between requests) but bounds how long the peer may take to deliver the
// frame body once the prefix has arrived. Without this, a peer that sends
// only a max-size length prefix and then stalls would pin a goroutine (and
// its frame buffer) forever.
func ReadMessageConn(conn net.Conn, msg any, bodyTimeout time.Duration) error {
	if bodyTimeout <= 0 {
		return readMessage(conn, msg, nil)
	}
	return readMessage(conn, msg, func() func() {
		_ = conn.SetReadDeadline(time.Now().Add(bodyTimeout))
		return func() { _ = conn.SetReadDeadline(time.Time{}) }
	})
}

// readMessage reads one length-prefixed JSON frame. armBodyDeadline, if
// non-nil, runs after the length prefix has been read and before the body is
// consumed; the function it returns runs once the body read finishes.
func readMessage(r io.Reader, msg any, armBodyDeadline func() func()) error {
	var length uint32
	if err := binary.Read(r, binary.BigEndian, &length); err != nil {
		return fmt.Errorf("read message length: %w", err)
	}

	if length > maxMessageSize {
		return fmt.Errorf("message size %d exceeds maximum %d", length, maxMessageSize)
	}

	if armBodyDeadline != nil {
		defer armBodyDeadline()()
	}

	// Grow the buffer as bytes actually arrive instead of allocating the full
	// advertised length up front: a peer that claims a 64 MiB frame but never
	// delivers it pins only what it actually sent.
	var payload bytes.Buffer
	if _, err := io.CopyN(&payload, r, int64(length)); err != nil {
		if err == io.EOF {
			err = io.ErrUnexpectedEOF
		}
		return fmt.Errorf("read message payload: %w", err)
	}

	if err := json.Unmarshal(payload.Bytes(), msg); err != nil {
		return fmt.Errorf("unmarshal message: %w", err)
	}

	return nil
}

// MarshalResult marshals a result value into json.RawMessage for embedding in
// a Response.
func MarshalResult(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		// Programming error — all result types must be marshalable.
		panic(fmt.Sprintf("guest: cannot marshal result: %v", err))
	}
	return b
}
