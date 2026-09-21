package routes

import (
	"context"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// ActiveWorkflowRunCounter is the authoritative per-user counter already used
// by Plue's workflow-dispatch quota middleware. Exposing this narrow read lets
// the edge Worker enforce the same account-wide safety cap before it provisions
// or contacts a per-repository Smithers gateway.
type ActiveWorkflowRunCounter interface {
	CountActiveWorkflowRunsForUser(ctx context.Context, userID int64) (int, error)
}

type WorkflowRunCountHandler struct {
	Counter ActiveWorkflowRunCounter
}

// GetActiveWorkflowRunCount handles GET /api/user/workflow-runs/active-count.
// Identity comes only from authenticated request context; callers cannot name a
// different user. The underlying query includes personal, organization, and
// collaborator repositories and intentionally counts shared-repository runs
// conservatively, matching PerUserConcurrentWorkflowRuns.
func (h *WorkflowRunCountHandler) GetActiveWorkflowRunCount(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		pkgerrors.WriteError(w, pkgerrors.Unauthorized("authentication required"))
		return
	}
	if h.Counter == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("workflow run counter unavailable"))
		return
	}

	count, err := h.Counter.CountActiveWorkflowRunsForUser(r.Context(), user.ID)
	if err != nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("failed to count active workflow runs"))
		return
	}

	w.Header().Set("Cache-Control", "no-store")
	pkgerrors.WriteJSON(w, http.StatusOK, map[string]int{"active_count": count})
}
