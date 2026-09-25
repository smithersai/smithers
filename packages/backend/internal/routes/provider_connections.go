package routes

import (
	"context"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// ProviderConnectionRouteService is the bring-your-own-subscription surface
// (RFD-003): connect, list, revoke, refresh, and grant connections.
type ProviderConnectionRouteService interface {
	ConnectForUser(ctx context.Context, actor *db.User, in services.ConnectProviderInput) (services.ProviderConnectionResponse, error)
	ConnectForOrg(ctx context.Context, actor *db.User, orgName string, in services.ConnectProviderInput) (services.ProviderConnectionResponse, error)
	ListForUser(ctx context.Context, actor *db.User) ([]services.ProviderConnectionResponse, error)
	ListForOrg(ctx context.Context, actor *db.User, orgName string) ([]services.ProviderConnectionResponse, error)
	Get(ctx context.Context, actor *db.User, id string) (services.ProviderConnectionResponse, error)
	Revoke(ctx context.Context, actor *db.User, id string) error
	RefreshNow(ctx context.Context, actor *db.User, id string) (services.ProviderConnectionResponse, error)
	AddGrant(ctx context.Context, actor *db.User, id string, in services.ProviderConnectionGrantInput) (services.ProviderConnectionGrantResponse, error)
	DeleteGrant(ctx context.Context, actor *db.User, id string, grantID int64) error
	Reorder(ctx context.Context, actor *db.User, provider string, ids []string) error
	StartCodexDeviceLogin(ctx context.Context, actor *db.User) (services.ProviderDeviceLoginResponse, error)
	PollCodexDeviceLogin(ctx context.Context, actor *db.User, id string) (services.ProviderDeviceLoginResponse, error)
}

type ProviderConnectionHandler struct {
	Service ProviderConnectionRouteService
	// Pool serves workspaces' model calls from connected accounts; nil
	// leaves /provider-pool unmounted.
	Pool *ProviderPoolHandler
}

// ListUserConnections handles GET /api/user/provider-connections.
func (h *ProviderConnectionHandler) ListUserConnections(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	out, err := h.Service.ListForUser(r.Context(), actor)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, out)
}

// ConnectUser handles POST /api/user/provider-connections.
func (h *ProviderConnectionHandler) ConnectUser(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	var in services.ConnectProviderInput
	if !decodeJSONBody(w, r, &in) {
		return
	}
	out, err := h.Service.ConnectForUser(r.Context(), actor, in)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusCreated, out)
}

// GetConnection handles GET /api/user/provider-connections/{id}.
func (h *ProviderConnectionHandler) GetConnection(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	out, err := h.Service.Get(r.Context(), actor, chi.URLParam(r, "id"))
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, out)
}

// RevokeConnection handles DELETE /api/user/provider-connections/{id}.
func (h *ProviderConnectionHandler) RevokeConnection(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	if err := h.Service.Revoke(r.Context(), actor, chi.URLParam(r, "id")); err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// RefreshConnection handles POST /api/user/provider-connections/{id}/refresh.
func (h *ProviderConnectionHandler) RefreshConnection(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	out, err := h.Service.RefreshNow(r.Context(), actor, chi.URLParam(r, "id"))
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, out)
}

// AddGrant handles POST /api/user/provider-connections/{id}/grants.
func (h *ProviderConnectionHandler) AddGrant(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	var in services.ProviderConnectionGrantInput
	if !decodeJSONBody(w, r, &in) {
		return
	}
	out, err := h.Service.AddGrant(r.Context(), actor, chi.URLParam(r, "id"), in)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusCreated, out)
}

// DeleteGrant handles DELETE /api/user/provider-connections/{id}/grants/{grantID}.
func (h *ProviderConnectionHandler) DeleteGrant(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	grantID, err := strconv.ParseInt(chi.URLParam(r, "grantID"), 10, 64)
	if err != nil || grantID <= 0 {
		errors.WriteError(w, errors.BadRequest("invalid grant id"))
		return
	}
	if err := h.Service.DeleteGrant(r.Context(), actor, chi.URLParam(r, "id"), grantID); err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ListOrgConnections handles GET /api/orgs/{org}/provider-connections.
func (h *ProviderConnectionHandler) ListOrgConnections(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	orgName, err := routeParam(r, "org", "organization name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	out, err := h.Service.ListForOrg(r.Context(), actor, orgName)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, out)
}

// ConnectOrg handles POST /api/orgs/{org}/provider-connections.
func (h *ProviderConnectionHandler) ConnectOrg(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	orgName, err := routeParam(r, "org", "organization name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	var in services.ConnectProviderInput
	if !decodeJSONBody(w, r, &in) {
		return
	}
	out, err := h.Service.ConnectForOrg(r.Context(), actor, orgName, in)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusCreated, out)
}

// ReorderConnections handles PUT /api/user/provider-connections/order: the
// rotation order of one provider's accounts.
func (h *ProviderConnectionHandler) ReorderConnections(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	var in struct {
		Provider string   `json:"provider"`
		IDs      []string `json:"ids"`
	}
	if !decodeJSONBody(w, r, &in) {
		return
	}
	if err := h.Service.Reorder(r.Context(), actor, in.Provider, in.IDs); err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// StartCodexDeviceLogin handles POST /api/user/provider-connections/codex/device.
func (h *ProviderConnectionHandler) StartCodexDeviceLogin(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	out, err := h.Service.StartCodexDeviceLogin(r.Context(), actor)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusCreated, out)
}

// PollCodexDeviceLogin handles POST /api/user/provider-connections/codex/device/{id}.
func (h *ProviderConnectionHandler) PollCodexDeviceLogin(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	out, err := h.Service.PollCodexDeviceLogin(r.Context(), actor, chi.URLParam(r, "id"))
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, out)
}
