// Package ports defines the small set of dependencies that differ between a
// single-owner installation and a clustered deployment. Product policy, SQL,
// HTTP handlers, job admission, and Flow semantics are not deployment ports.
package ports

import (
	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/repository"
	"github.com/smithersai/smithers/packages/backend/workspace"
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

// ObjectAttrs and SignedUpload are the value types in the shared blob
// contract. Re-exporting them lets an external deployment implement BlobStore
// and its optional capabilities without importing an internal Go package.
type ObjectAttrs = blob.ObjectAttrs
type SignedUpload = blob.SignedUpload
type CreateOnlyUploadSigner = blob.CreateOnlyUploadSigner
type CreateOnlyPromoter = blob.CreateOnlyPromoter
type GenerationPurger = blob.GenerationPurger
type Putter = blob.Putter

const UnknownObjectSize = blob.UnknownObjectSize

var ErrObjectNotFound = blob.ErrObjectNotFound
var ErrObjectAlreadyExists = blob.ErrObjectAlreadyExists

// AgentLogStore persists archived session transcripts through the same
// deployment-owned storage boundary.
type AgentLogStore = services.AgentLogStore

// Workspace lifecycle aliases keep deployment injection types available from
// ports without making common services import this composition package.
type IsolationLevel = workspace.IsolationLevel

const (
	IsolationTrustedProcess   = workspace.IsolationTrustedProcess
	IsolationSandboxed        = workspace.IsolationSandboxed
	WorkspaceStarting         = workspace.WorkspaceStarting
	WorkspaceRunning          = workspace.WorkspaceRunning
	WorkspaceStopping         = workspace.WorkspaceStopping
	WorkspaceStopped          = workspace.WorkspaceStopped
	WorkspaceFailed           = workspace.WorkspaceFailed
	WorkspaceRecoveryRequired = workspace.WorkspaceRecoveryRequired
	ServiceRunning            = workspace.ServiceRunning
	ServiceExited             = workspace.ServiceExited
)

var (
	ErrWorkspaceNotFound = workspace.ErrWorkspaceNotFound
	ErrWorkspaceStopped  = workspace.ErrWorkspaceStopped
)

type Terminal = workspace.Terminal
type WorkspaceState = workspace.WorkspaceState
type WorkspaceCapabilities = workspace.WorkspaceCapabilities
type WorkspaceSpec = workspace.WorkspaceSpec
type Workspace = workspace.Workspace
type ColdSnapshot = workspace.ColdSnapshot
type ColdSnapshotSpec = workspace.ColdSnapshotSpec
type WorkspaceSnapshots = workspace.WorkspaceSnapshots
type Command = workspace.Command
type CommandResult = workspace.CommandResult
type ServiceSpec = workspace.ServiceSpec
type Service = workspace.Service
type ServiceState = workspace.ServiceState
type ServiceObservation = workspace.ServiceObservation
type PreviewTarget = workspace.PreviewTarget
type FileEntry = workspace.FileEntry
type WorkspaceLifecycle = workspace.WorkspaceLifecycle
type WorkspaceExecution = workspace.WorkspaceExecution
type WorkspaceTerminal = workspace.WorkspaceTerminal
type WorkspacePreview = workspace.WorkspacePreview
type WorkspaceFiles = workspace.WorkspaceFiles
type WorkspaceRuntime = workspace.WorkspaceRuntime
