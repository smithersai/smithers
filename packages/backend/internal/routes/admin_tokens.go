package routes

import (
	"context"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type AdminTokenRouteService interface {
	ListTokens(context.Context, db.AdminListTokensParams) ([]services.AdminToken, error)
}
type AdminTokenHandler struct{ Service AdminTokenRouteService }

func (h *AdminTokenHandler) List(w http.ResponseWriter, r *http.Request) {
	limit, err := manageQueryInt(r, "limit", 100, 1, 500)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	unused, err := manageQueryInt(r, "unused_days", 0, 1, 365000)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	expiring, err := manageQueryInt(r, "expiring_days", 0, 1, 365000)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	result, err := h.Service.ListTokens(r.Context(), db.AdminListTokensParams{RowLimit: limit, UnusedDays: unused, ExpiringDays: expiring, Scope: r.URL.Query().Get("scope")})
	manageRespond(w, r, result, err)
}
