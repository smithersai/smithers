// Package operations exposes the canonical product collaborators needed by a
// deployment's control plane. Instances come from app.Start; deployments do not
// build a second set of product services.
package operations

import (
	"context"
	"net/http"
	"time"

	"github.com/smithersai/smithers/packages/backend/blobs"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

type WorkspaceResponse = services.WorkspaceResponse
type DispatchForEventInput = services.DispatchForEventInput
type WorkflowRunResult = services.WorkflowRunResult
type CommitStatus = db.CommitStatus
type SecretInjector = services.SecretInjector
type Metrics = routes.SmithersMetrics

type AgentControl interface {
	CancelSession(context.Context, string, int64, string) error
}
type WorkspaceControl interface {
	StopWorkspace(context.Context, string, int64, int64) (WorkspaceResponse, error)
	SuspendWorkspace(context.Context, string, int64, int64) (WorkspaceResponse, error)
}
type WorkflowDispatcher interface {
	DispatchForEvent(context.Context, DispatchForEventInput) ([]WorkflowRunResult, error)
	CancelRun(context.Context, int64, int64) error
}
type CommitStatusWriter interface {
	UpdateCommitStatusForWorkflowRun(context.Context, int64, string, string, string) (CommitStatus, error)
}
type StreamCounter interface{ ActiveConnections() int }

// Access uses the same authentication, revocation, CSRF, scope and rate-limit
// controls as the product routes. The deployment still owns its route table.
type Access struct {
	Service     func(http.Handler) http.Handler
	AdminRead   func(http.Handler) http.Handler
	AdminWrite  func(http.Handler) http.Handler
	AgentTask   func(http.Handler) http.Handler
	SharedAgent func(http.Handler) http.Handler
}

// HTTPSettings are the already-validated settings used by the product server.
type HTTPSettings struct {
	Address           string
	ReadTimeout       time.Duration
	ReadHeaderTimeout time.Duration
	WriteTimeout      time.Duration
	IdleTimeout       time.Duration
	ShutdownTimeout   time.Duration
}

// Bindings is a snapshot of collaborators owned by the running app. Copying it
// does not transfer ownership; all calls must stop before the app is closed.
type Bindings struct {
	Blobs               blobs.Store
	WorkflowsEnabled    bool
	WorkersRunning      bool
	HTTPEnabled         bool
	Agents              AgentControl
	Workspaces          WorkspaceControl
	Workflows           WorkflowDispatcher
	CommitStatuses      CommitStatusWriter
	GitHubChecks        services.GitHubCheckRunService
	GitHubInstallations services.GitHubRepositoryInstallationResolver
	Secrets             *SecretInjector
	Webhooks            webhooks.Dispatcher
	Metrics             *Metrics
	Streams             StreamCounter
	Access              Access
	HTTP                HTTPSettings
}
