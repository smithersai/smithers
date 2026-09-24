package routes

import (
	"context"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type SandboxEgressAuditRouteService interface {
	List(context.Context, string, string, int64, string, int) (services.SandboxEgressAuditList, error)
}

func serveSandboxEgressAudit(w http.ResponseWriter, r *http.Request, service SandboxEgressAuditRouteService, resourceKind, resourceID string) {
	if service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("sandbox egress audit service unavailable"))
		return
	}
	repoCtx := middleware.RepoContextFromContext(r.Context())
	if repoCtx == nil || repoCtx.Repository == nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("repository context required"))
		return
	}
	cursor, limit, err := parsePagination(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}
	result, svcErr := service.List(r.Context(), resourceKind, resourceID, repoCtx.Repository.ID, cursor, limit)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}
	setCursorPaginationHeaders(w, r, limit, result.NextCursor)
	pkgerrors.WriteJSON(w, http.StatusOK, result.Items)
}
