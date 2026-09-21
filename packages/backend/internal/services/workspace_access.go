package services

import (
	"context"
	"errors"
	"log/slog"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// WorkspaceAccessLevel is the minimum permission required to operate on a workspace.
type WorkspaceAccessLevel string

const (
	// WorkspaceAccessRead permits listing, viewing status, and streaming SSE.
	WorkspaceAccessRead WorkspaceAccessLevel = "read"
	// WorkspaceAccessWrite permits all mutations: suspend, resume, fork, snapshot,
	// create/destroy sessions, and access SSH credentials.
	WorkspaceAccessWrite WorkspaceAccessLevel = "write"
)

// requireWorkspaceAccess returns nil if requesterUserID either owns the
// workspace or holds an explicit share grant at or above minLevel.
//
// Access matrix:
//
//	owner + any level  → allowed
//	non-owner, share.level == "write", minLevel == "read"  → allowed
//	non-owner, share.level == "write", minLevel == "write" → allowed
//	non-owner, share.level == "read",  minLevel == "read"  → allowed
//	non-owner, share.level == "read",  minLevel == "write" → 403
//	non-owner, no share row                                 → 403
//
// The function purposefully does not distinguish "workspace not found" from
// "you are not the owner" when no explicit share exists — both return 403.
// This prevents ownership enumeration via timing or error shape differences.
func (s *WorkspaceService) requireWorkspaceAccess(ctx context.Context, workspaceID string, ownerUserID, requesterUserID int64, minLevel WorkspaceAccessLevel) error {
	if ownerUserID == requesterUserID {
		return nil
	}

	share, err := s.q.GetWorkspaceShare(ctx, db.GetWorkspaceShareParams{
		WorkspaceID:   workspaceID,
		GranteeUserID: requesterUserID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.Forbidden("access denied")
		}
		return pkgerrors.Internal("check workspace share: " + err.Error())
	}

	// read share satisfies read-level only; write share satisfies both.
	if minLevel == WorkspaceAccessWrite && share.Level != string(WorkspaceAccessWrite) {
		return pkgerrors.Forbidden("access denied: write permission required")
	}
	return nil
}

// touchWorkspaceEntryRecency centralizes ticket 0136 semantics:
// real user-entry flows bump workspaces.last_accessed_at, while passive
// reads (list/detail/polling) must not call this helper.
func (s *WorkspaceService) touchWorkspaceEntryRecency(ctx context.Context, workspaceID, accessPath string) {
	if s == nil || s.q == nil {
		return
	}
	id := strings.TrimSpace(workspaceID)
	if id == "" {
		return
	}
	if err := s.q.TouchWorkspaceLastAccessed(ctx, id); err != nil {
		slog.Warn("touch workspace last_accessed_at failed", "workspace_id", id, "access_path", accessPath, "error", err)
	}
}
