package compose

import (
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/ports"
)

// Preserve each injected concrete adapter: optional transaction and accounting
// methods are part of the service contract and must not be narrowed away.
func resolveProductRuntimeStores(stores ports.RuntimeStores, product *db.Queries) ports.RuntimeStores {
	if stores.LFS == nil {
		stores.LFS = product
	}
	if stores.WorkflowCache == nil {
		stores.WorkflowCache = product
	}
	if stores.WorkflowArtifacts == nil {
		stores.WorkflowArtifacts = product
	}
	if stores.WorkflowRuns == nil {
		stores.WorkflowRuns = product
	}
	if stores.AgentDispatch == nil {
		stores.AgentDispatch = product
	}
	if stores.Workspaces == nil {
		stores.Workspaces = product
	}
	return stores
}
