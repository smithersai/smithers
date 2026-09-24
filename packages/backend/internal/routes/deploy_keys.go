package routes

import (
	"context"
	"fmt"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type DeployKeyRouteService interface {
	ListDeployKeys(ctx context.Context, owner, repo string) ([]services.DeployKeyResponse, error)
	CreateDeployKey(ctx context.Context, owner, repo string, req services.CreateDeployKeyRequest) (services.DeployKeyResponse, error)
	DeleteDeployKey(ctx context.Context, owner, repo string, keyID int64) error
}

type DeployKeyHandler struct {
	Service      DeployKeyRouteService
	AuditService *services.AuditService
}

func (h *DeployKeyHandler) ListDeployKeys(w http.ResponseWriter, r *http.Request) {
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	keys, svcErr := h.Service.ListDeployKeys(r.Context(), owner, repo)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	errors.WriteJSON(w, http.StatusOK, keys)
}

func (h *DeployKeyHandler) CreateDeployKey(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	var req services.CreateDeployKeyRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	created, svcErr := h.Service.CreateDeployKey(r.Context(), owner, repo, req)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	if h.AuditService != nil {
		h.AuditService.Log(r.Context(), services.AuditEvent{
			EventType:  "deploy_key.create",
			ActorID:    &user.ID,
			ActorName:  user.Username,
			TargetType: "deploy_key",
			TargetID:   &created.ID,
			TargetName: created.Title,
			Action:     "create",
			IPAddress:  r.RemoteAddr,
		})
	}

	errors.WriteJSON(w, http.StatusCreated, created)
}

func (h *DeployKeyHandler) DeleteDeployKey(w http.ResponseWriter, r *http.Request) {
	user, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	keyID, err := parseInt64RouteParam(r, "id", "deploy key id is required", "invalid deploy key id")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	if svcErr := h.Service.DeleteDeployKey(r.Context(), owner, repo, keyID); svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	if h.AuditService != nil {
		h.AuditService.Log(r.Context(), services.AuditEvent{
			EventType:  "deploy_key.delete",
			ActorID:    &user.ID,
			ActorName:  user.Username,
			TargetType: "deploy_key",
			TargetID:   &keyID,
			TargetName: fmt.Sprintf("deploy_key_%d", keyID),
			Action:     "delete",
			IPAddress:  r.RemoteAddr,
		})
	}

	w.WriteHeader(http.StatusNoContent)
}
