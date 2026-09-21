package routes

import (
	"github.com/smithersai/smithers/packages/backend/internal/clusterservices"
	"context"
	"net/http"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// AdminRunnerRouteService is the service contract for admin runner endpoints.
type AdminRunnerRouteService interface {
	ListRunners(ctx context.Context, input clusterservices.RunnerAdminListInput) ([]db.RunnerPool, int64, error)
}

// AdminRunnerHandler handles /api/admin/runners requests.
type AdminRunnerHandler struct {
	Service AdminRunnerRouteService
}

// runnerResponse is the JSON shape returned by the admin runners endpoint.
type runnerResponse struct {
	ID              int64      `json:"id"`
	Name            string     `json:"name"`
	Status          string     `json:"status"`
	LastHeartbeatAt *time.Time `json:"last_heartbeat_at"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
}

func toRunnerResponse(r db.RunnerPool) runnerResponse {
	resp := runnerResponse{
		ID:        r.ID,
		Name:      r.Name,
		Status:    r.Status,
		CreatedAt: r.CreatedAt,
		UpdatedAt: r.UpdatedAt,
	}
	if r.LastHeartbeatAt.Valid {
		t := r.LastHeartbeatAt.Time
		resp.LastHeartbeatAt = &t
	}
	return resp
}

// ListRunners handles GET /api/admin/runners.
// Requires: authenticated admin user.
// Query params: page, per_page (pagination), status (filter).
func (h *AdminRunnerHandler) ListRunners(w http.ResponseWriter, r *http.Request) {
	cursor, limit, err := parsePagination(r)
	if err != nil {
		pkgerrors.WriteError(w, err.(*pkgerrors.APIError))
		return
	}

	statusFilter := r.URL.Query().Get("status")

	page := cursorToPage(cursor, limit)
	runners, total, err := h.Service.ListRunners(r.Context(), clusterservices.RunnerAdminListInput{
		Page:         page,
		PerPage:      limit,
		StatusFilter: statusFilter,
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	setPaginationHeaders(w, r, cursor, limit, len(runners), total)

	resp := make([]runnerResponse, len(runners))
	for i, rp := range runners {
		resp[i] = toRunnerResponse(rp)
	}

	pkgerrors.WriteJSON(w, http.StatusOK, resp)
}
