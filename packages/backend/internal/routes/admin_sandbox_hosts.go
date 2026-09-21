package routes

import (
	"context"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type AdminSandboxHostRouteService interface {
	ListSandboxHosts(context.Context) ([]services.AdminSandboxHost, error)
	DrainSandboxHost(context.Context, string) (services.AdminHostState, error)
	PruneStaleSandboxHosts(context.Context, int32) (services.AdminPruneResult, error)
}
type AdminSandboxHostHandler struct{ Service AdminSandboxHostRouteService }

func (h *AdminSandboxHostHandler) List(w http.ResponseWriter, r *http.Request) {
	result, err := h.Service.ListSandboxHosts(r.Context())
	manageRespond(w, r, result, err)
}
func (h *AdminSandboxHostHandler) Drain(w http.ResponseWriter, r *http.Request) {
	id, err := manageID(r, false)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	result, err := h.Service.DrainSandboxHost(adminUserAuditContext(r), id)
	manageRespond(w, r, result, err)
}
func (h *AdminSandboxHostHandler) PruneStale(w http.ResponseWriter, r *http.Request) {
	body := struct {
		OlderThanHours int32 `json:"older_than_hours"`
	}{OlderThanHours: 24}
	if !manageBody(w, r, &body) {
		return
	}
	if body.OlderThanHours < 1 || body.OlderThanHours > 876000 {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid older_than_hours"))
		return
	}
	result, err := h.Service.PruneStaleSandboxHosts(adminUserAuditContext(r), body.OlderThanHours)
	manageRespond(w, r, result, err)
}
