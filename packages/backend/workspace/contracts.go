// Package workspace defines the shared execution and workspace lifecycle.
// Product authorization, admission, and durable receipts stay above this boundary.
package workspace

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"time"
)

// IsolationLevel is the guarantee of an execution adapter, not an edition
// label. A trusted process must never be presented as an untrusted sandbox.
type IsolationLevel string

const (
	IsolationTrustedProcess IsolationLevel = "trusted_process"
	IsolationSandboxed      IsolationLevel = "isolated"
)

// Terminal is an interactive byte stream scoped to an authorized workspace.
// The common app authenticates and authorizes before opening it.
type Terminal interface {
	io.ReadWriteCloser
	Resize(ctx context.Context, columns, rows uint16) error
}

// ErrWorkspaceNotFound is returned when an execution adapter has no durable
// workspace with the requested product-owned identifier.
var ErrWorkspaceNotFound = errors.New("workspace not found")

// ErrWorkspaceStopped is returned when an operation needs a running workspace.
var ErrWorkspaceStopped = errors.New("workspace is stopped")

// WorkspaceState is the execution lifecycle observed by product code. A
// stopped persistent workspace keeps its files but owns no live processes.
type WorkspaceState string

const (
	WorkspaceStarting         WorkspaceState = "starting"
	WorkspaceRunning          WorkspaceState = "running"
	WorkspaceStopping         WorkspaceState = "stopping"
	WorkspaceStopped          WorkspaceState = "stopped"
	WorkspaceFailed           WorkspaceState = "failed"
	WorkspaceRecoveryRequired WorkspaceState = "recovery_required"
)

// WorkspaceCapabilities are facts an adapter has actually implemented. In
// particular, ColdSnapshots must remain false for a process adapter that only
// persists the workspace directory.
type WorkspaceCapabilities struct {
	PersistentFiles bool
	Execution       bool
	ManagedServices bool
	Terminal        bool
	LoopbackPreview bool
	FileOperations  bool
	ColdSnapshots   bool
}

// WorkspaceSpec carries only durable execution identity. Authentication,
// admission, repository ownership, and receipts remain common product policy.
type WorkspaceSpec struct {
	ID string
}

// Workspace describes paths in the execution environment's namespace. Root is
// where repository material is placed. Home, StateDir, and TempDir stay
// outside that working tree. Callers use WorkspaceFiles rather than assuming
// these paths are visible in the backend process; they are host paths for the
// process adapter and guest paths for an isolated remote adapter.
type Workspace struct {
	ID       string
	Root     string
	Home     string
	StateDir string
	TempDir  string
	State    WorkspaceState
}

// ColdSnapshot is disk state captured from a stopped workspace. It carries no
// claim about preserving process memory.
type ColdSnapshot struct {
	ID                string
	SourceWorkspaceID string
}

type ColdSnapshotSpec struct {
	ID string
}

// WorkspaceSnapshots is an optional capability. A runtime advertising
// ColdSnapshots implements it; the local process runtime deliberately does
// neither, so unsupported snapshot operations cannot report fake success.
type WorkspaceSnapshots interface {
	CreateColdSnapshot(ctx context.Context, workspaceID string, spec ColdSnapshotSpec) (ColdSnapshot, error)
	ForkColdSnapshot(ctx context.Context, snapshotID string, spec WorkspaceSpec) (Workspace, error)
	DeleteColdSnapshot(ctx context.Context, snapshotID string) error
}

// Command is an argv-based process request. Directory is relative to the
// workspace root. Environment augments the adapter's controlled environment
// for this operation and is never durable workspace metadata.
type Command struct {
	Args        []string
	Directory   string
	Environment map[string]string
}

// CommandResult is direct process evidence. Product code remains responsible
// for committing the durable completion receipt.
type CommandResult struct {
	ExitCode        int
	Stdout          string
	Stderr          string
	OutputTruncated bool
}

// ServiceSpec describes one adapter-managed long-lived process. ReadyAddress,
// when set, must be a loopback host:port in the workspace's network namespace
// that accepts TCP connections before StartService returns.
type ServiceSpec struct {
	Name string
	// Identity is a caller-computed, secret-free configuration digest used to
	// deduplicate retries when an adapter-assigned address changes the argv.
	Identity     string
	Command      Command
	ReadyAddress string
	ReadyTimeout time.Duration
}

// Service is an observation of a process accepted by the adapter.
type Service struct {
	Name    string
	PID     int
	Address string
}

type ServiceState string

const (
	ServiceRunning ServiceState = "running"
	ServiceExited  ServiceState = "exited"
	ServiceStopped ServiceState = "stopped"
	ServiceFailed  ServiceState = "failed"
)

// ServiceObservation exposes bounded process evidence for diagnostics. It is
// not a workflow completion receipt.
type ServiceObservation struct {
	Service
	State           ServiceState
	ExitCode        int
	Stdout          string
	Stderr          string
	OutputTruncated bool
}

// PreviewTarget is an internal upstream for the common authenticated proxy.
// It is never evidence that the process is isolated from its host.
type PreviewTarget struct {
	URL string
}

// FileEntry describes one direct child of a workspace directory.
type FileEntry struct {
	Name  string
	Mode  fs.FileMode
	Size  int64
	IsDir bool
}

// WorkspaceLifecycle owns durable files and live execution state.
type WorkspaceLifecycle interface {
	Isolation() IsolationLevel
	Capabilities() WorkspaceCapabilities
	CreateWorkspace(ctx context.Context, spec WorkspaceSpec) (Workspace, error)
	InspectWorkspace(ctx context.Context, workspaceID string) (Workspace, error)
	StartWorkspace(ctx context.Context, workspaceID string) (Workspace, error)
	StopWorkspace(ctx context.Context, workspaceID string) error
	DeleteWorkspace(ctx context.Context, workspaceID string) error
}

// WorkspaceExecution runs admitted work and manages long-lived helpers.
type WorkspaceExecution interface {
	ExecuteCommand(ctx context.Context, workspaceID string, command Command) (CommandResult, error)
	StartService(ctx context.Context, workspaceID string, spec ServiceSpec) (Service, error)
	InspectService(ctx context.Context, workspaceID, name string) (ServiceObservation, error)
	StopService(ctx context.Context, workspaceID, name string) error
}

// WorkspaceServiceCatalog is optional because not every execution backend can
// enumerate its init system. A runtime advertising ManagedServices implements
// it so the common product service can list real observations.
type WorkspaceServiceCatalog interface {
	ListServices(ctx context.Context, workspaceID string) ([]ServiceObservation, error)
}

// WorkspaceNamedServiceController preserves deployment-defined service
// semantics such as systemd units without exposing an init-system model to the
// common product service.
type WorkspaceNamedServiceController interface {
	ManageService(ctx context.Context, workspaceID, name, action string) (ServiceObservation, error)
}

// WorkspaceTerminal opens a real PTY after common authorization succeeds.
type WorkspaceTerminal interface {
	OpenWorkspaceTerminal(ctx context.Context, workspaceID string, command Command) (Terminal, error)
}

// WorkspacePreview resolves an authorized workspace port to a local upstream.
type WorkspacePreview interface {
	PreviewTarget(ctx context.Context, workspaceID string, port uint16) (PreviewTarget, error)
}

// WorkspaceFiles provides path-scoped file operations. Implementations must
// reject traversal and symlink escapes from the workspace root.
type WorkspaceFiles interface {
	ReadFile(ctx context.Context, workspaceID, path string) ([]byte, error)
	WriteFile(ctx context.Context, workspaceID, path string, content []byte, mode fs.FileMode) error
	ListFiles(ctx context.Context, workspaceID, path string) ([]FileEntry, error)
	RemoveFile(ctx context.Context, workspaceID, path string) error
}

// WorkspaceRuntime is the common execution contract. Deployments may expose
// narrower facets to services that do not need every operation. Optional
// capabilities such as WorkspaceSnapshots remain separate interfaces.
type WorkspaceRuntime interface {
	WorkspaceLifecycle
	WorkspaceExecution
	WorkspaceTerminal
	WorkspacePreview
	WorkspaceFiles
	io.Closer
}
