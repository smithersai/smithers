package services

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func (s *WorkspaceService) sandboxIdleTimeout(ctx context.Context, userID, repositoryID int64) (int32, error) {
	entitlement, err := sandboxEntitlementForUser(ctx, s.billing, userID)
	if err != nil {
		return 0, err
	}
	store, ok := s.q.(interface {
		GetRepoByID(context.Context, int64) (db.Repository, error)
	})
	if !ok {
		return 0, pkgerrors.Internal("workspace repository store unavailable")
	}
	repo, err := store.GetRepoByID(ctx, repositoryID)
	if err != nil {
		return 0, err
	}
	return lowerSandboxIdleTimeout(entitlement.IdleTimeoutSecs, repo.WorkspaceIdleTimeoutSecs), nil
}

// Zero is infinity for the plan; a repository's positive override may only lower it.
func lowerSandboxIdleTimeout(plan int64, override int32) int32 {
	if override > 0 && (plan == 0 || int64(override) < plan) {
		return override
	}
	return int32(plan)
}

func (s *WorkspaceService) createWorkspaceRow(ctx context.Context, arg db.CreateWorkspaceParams) (db.Workspace, error) {
	if s.billing != nil {
		idle, err := s.sandboxIdleTimeout(ctx, arg.UserID, arg.RepositoryID)
		if err != nil {
			return db.Workspace{}, err
		}
		arg.IdleTimeoutSecs = pgtype.Int4{Int32: idle, Valid: true}
	}
	return s.q.CreateWorkspace(ctx, arg)
}

func (s *WorkspaceService) stampResumedWorkspaceIdleTimeout(ctx context.Context, workspace db.Workspace) (db.Workspace, error) {
	if s.billing == nil {
		return workspace, nil
	}
	idle, err := s.sandboxIdleTimeout(ctx, workspace.UserID, workspace.RepositoryID)
	if err != nil {
		return workspace, err
	}
	store, ok := s.q.(interface {
		SetWorkspaceIdleTimeout(context.Context, db.SetWorkspaceIdleTimeoutParams) (db.Workspace, error)
	})
	if !ok {
		return workspace, pkgerrors.Internal("workspace idle timeout store unavailable")
	}
	return store.SetWorkspaceIdleTimeout(ctx, db.SetWorkspaceIdleTimeoutParams{ID: workspace.ID, IdleTimeoutSecs: idle})
}

// Each provision gets its own config copy; plan timeouts must not mutate the
// shared service while other users provision concurrently.
func (s *WorkspaceService) withWorkspaceIdleTimeout(workspace db.Workspace) *WorkspaceService {
	if s.billing == nil {
		return s
	}
	scoped := *s
	scoped.workspaceIdleTimeoutSeconds = int64(workspace.IdleTimeoutSecs)
	return &scoped
}
