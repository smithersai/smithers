// Package ports defines the small set of dependencies that differ between a
// single-owner installation and a clustered deployment. Product policy, SQL,
// HTTP handlers, job admission, and Flow semantics are not deployment ports.
package ports

import (
	"context"
	"io"
)

// RepositoryEndpointResolver chooses the storage/execution endpoint for a
// repository. The common repository client still owns its operation protocol;
// local installations resolve to their bundled repository service, while a
// cluster can route to a storage set. The returned URL must come from trusted
// configuration, never a user-controlled or mutable operation record.
type RepositoryEndpointResolver interface {
	ResolveURL(ctx context.Context, owner, repo string) (string, error)
}

// Blob describes immutable stored bytes. Digest is a lowercase SHA-256 hex
// string. A provider that cannot report a digest leaves it empty; callers
// requiring integrity must then verify the stream themselves.
type Blob struct {
	Size   int64
	Digest string
}

// BlobStore is the common storage contract. PutIfAbsent is create-only, and
// duplicate keys must not overwrite existing bytes. Keys are product-owned;
// adapters must reject traversal outside their configured namespace. There is
// intentionally no required signed-URL method: browser transfers can stream
// through the product API in the single-container edition.
type BlobStore interface {
	PutIfAbsent(ctx context.Context, key string, body io.Reader) (Blob, error)
	Open(ctx context.Context, key string) (io.ReadCloser, Blob, error)
	Stat(ctx context.Context, key string) (Blob, error)
	Delete(ctx context.Context, key string) error
}

// IsolationLevel is the guarantee of an execution adapter, not an edition
// label. A trusted process must never be presented as an untrusted sandbox.
type IsolationLevel string

const (
	IsolationTrustedProcess IsolationLevel = "trusted_process"
	IsolationSandboxed      IsolationLevel = "isolated"
)

// Workload identifies already admitted work. Product admission and durable
// receipts live in the common PostgreSQL implementation. The executor must
// honor context cancellation and its configured concurrency budget.
type Workload struct {
	ID          string
	WorkspaceID string
	Command     []string
	Directory   string
}

// ExecutionResult is an observation, not a product completion receipt. The
// common worker commits a terminal receipt after reconciliation.
type ExecutionResult struct {
	ExitCode int
}

type Executor interface {
	Isolation() IsolationLevel
	Execute(ctx context.Context, work Workload) (ExecutionResult, error)
}

// Terminal is an interactive byte stream scoped to an authorized workspace.
// The common app authenticates and authorizes before calling OpenTerminal.
type Terminal interface {
	io.ReadWriteCloser
	Resize(ctx context.Context, columns, rows uint16) error
}

type WorkspaceAccess interface {
	OpenTerminal(ctx context.Context, workspaceID string) (Terminal, error)
}
