package runtimeports

import "context"

// WorkspaceSandboxAdoption is an optional method of the Workspaces runtime
// store for deployments whose sandbox inventory is private. The provider may
// accept a create before the product persists the workspace's vm_id; the
// provisioning reconciler adopts that guest instead of allocating a second.
// It returns "" (or pgx.ErrNoRows) when no live unregistered sandbox exists.
type WorkspaceSandboxAdoption interface {
	FindUnregisteredWorkspaceSandbox(ctx context.Context, workspaceID string) (string, error)
}
