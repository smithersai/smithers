package compose

import (
	"context"
	"errors"

	"github.com/smithersai/smithers/packages/backend/admission"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Admission is rechecked by the worker immediately before a managed host start.
// A durable launch can outlive the subscription that authorized its request.
// Existing-host reads/inspection and retirement do not acquire a new slot.
type admittedFlowLauncher struct {
	flowhost.Launcher
	flowhost.SourceResolver
	flowhost.RetirementStopper
	queries *db.Queries
	policy  admission.Policy
}

func newAdmittedFlowLauncher(launcher flowhost.Launcher, queries *db.Queries, policy admission.Policy) (*admittedFlowLauncher, error) {
	source, sourceOK := launcher.(flowhost.SourceResolver)
	stopper, stopOK := launcher.(flowhost.RetirementStopper)
	if queries == nil || policy == nil || !sourceOK || !stopOK {
		return nil, errors.New("Flow launch requires admission, workspace queries, source and retirement authority")
	}
	return &admittedFlowLauncher{Launcher: launcher, SourceResolver: source, RetirementStopper: stopper, queries: queries, policy: policy}, nil
}

func (l *admittedFlowLauncher) StartFlowHost(ctx context.Context, launch flowhost.HostLaunch) (flowhost.Connection, error) {
	workspace, err := l.queries.GetWorkspace(ctx, launch.Authority.WorkspaceID)
	if err != nil {
		return flowhost.Connection{}, err
	}
	if workspace.UserID != launch.Authority.UserID || workspace.RepositoryID != launch.Authority.RepositoryID || workspace.DeletedAt.Valid {
		return flowhost.Connection{}, errors.New("Flow workspace authority changed before launch")
	}
	if err := l.policy.AuthorizeCountedSandboxResume(ctx, workspace.UserID, workspace.ID, workspace.VmID); err != nil {
		return flowhost.Connection{}, err
	}
	return l.Launcher.StartFlowHost(ctx, launch)
}
