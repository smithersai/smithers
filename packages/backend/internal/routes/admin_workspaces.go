package routes

import (
	"github.com/smithersai/smithers/packages/backend/internal/clusterservices"
	"context"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type AdminWorkspaceRouteService interface {
	ListWorkspaces(context.Context, db.AdminListWorkspacesParams) ([]clusterservices.AdminWorkspace, error)
	StopWorkspace(context.Context, string) (clusterservices.AdminManageStatus, error)
	SuspendWorkspace(context.Context, string) (clusterservices.AdminManageStatus, error)
}
type AdminWorkspaceHandler struct{ Service AdminWorkspaceRouteService }

func (h *AdminWorkspaceHandler) List(w http.ResponseWriter, r *http.Request) {
	limit, err := manageQueryInt(r, "limit", 100, 1, 200)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	synthetic, err := manageSynthetic(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	q := r.URL.Query()
	result, err := h.Service.ListWorkspaces(r.Context(), db.AdminListWorkspacesParams{Status: q.Get("status"), Kind: q.Get("kind"), Owner: q.Get("owner"), IncludeSynthetic: synthetic, RowLimit: limit})
	manageRespond(w, r, result, err)
}
func (h *AdminWorkspaceHandler) Stop(w http.ResponseWriter, r *http.Request) {
	id, err := manageID(r, true)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	result, err := h.Service.StopWorkspace(adminUserAuditContext(r), id)
	manageRespond(w, r, result, err)
}
func (h *AdminWorkspaceHandler) Suspend(w http.ResponseWriter, r *http.Request) {
	id, err := manageID(r, true)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	result, err := h.Service.SuspendWorkspace(adminUserAuditContext(r), id)
	manageRespond(w, r, result, err)
}
