// Package ports defines the small set of dependencies that differ between a
// single-owner installation and a clustered deployment. Product policy, SQL,
// HTTP handlers, job admission, and Flow semantics are not deployment ports.
package ports

import (
	"context"
	"io"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/repository"
)

// RepositoryEndpointResolver chooses the storage/execution endpoint for a
// repository. The common repository client still owns its operation protocol;
// local installations resolve to their bundled repository service, while a
// cluster can route to a storage set. The returned URL must come from trusted
// configuration, never a user-controlled or mutable operation record.
type RepositoryEndpointResolver = repository.StorageSetResolver

// BlobStore is the actual product blob contract consumed by the extracted
// services. The alias prevents a second storage model from drifting away from
// the routes and artifact/LFS semantics. The local adapter implements signed
// transfer URLs through authenticated application routes; cloud adapters can
// use provider-signed URLs. Callers import this public alias, never internal.
type BlobStore = blob.Store

// AgentLogStore persists archived session transcripts through the same
// deployment-owned storage boundary.
type AgentLogStore = services.AgentLogStore

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
