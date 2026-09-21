package routes

import (
	"context"
	"fmt"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type SSHKeyRouteService interface {
	ListKeys(ctx context.Context, userID int64) ([]services.SSHKeyResponse, error)
	GetKeyByID(ctx context.Context, userID, keyID int64) (services.SSHKeyResponse, error)
	CreateKey(ctx context.Context, userID int64, req services.CreateSSHKeyRequest) (services.SSHKeyResponse, error)
	DeleteKey(ctx context.Context, userID, keyID int64) error
}

type SSHKeyHandler struct {
	Service      SSHKeyRouteService
	AuditService *services.AuditService
}

func (h *SSHKeyHandler) ListSSHKeys(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	keys, err := h.Service.ListKeys(r.Context(), user.ID)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	errors.WriteJSON(w, http.StatusOK, keys)
}

func (h *SSHKeyHandler) GetSSHKey(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	keyID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || keyID <= 0 {
		errors.WriteError(w, errors.BadRequest("invalid ssh key id"))
		return
	}

	key, svcErr := h.Service.GetKeyByID(r.Context(), user.ID, keyID)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	errors.WriteJSON(w, http.StatusOK, key)
}

func (h *SSHKeyHandler) CreateSSHKey(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	var req services.CreateSSHKeyRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	created, err := h.Service.CreateKey(r.Context(), user.ID, req)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	if h.AuditService != nil {
		h.AuditService.Log(r.Context(), services.AuditEvent{
			EventType:  "ssh_key.create",
			ActorID:    &user.ID,
			ActorName:  user.Username,
			TargetType: "ssh_key",
			TargetID:   &created.ID,
			TargetName: created.Name,
			Action:     "create",
			IPAddress:  r.RemoteAddr,
		})
	}

	errors.WriteJSON(w, http.StatusCreated, created)
}

func (h *SSHKeyHandler) DeleteSSHKey(w http.ResponseWriter, r *http.Request) {
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		errors.WriteError(w, errors.Unauthorized("authentication required"))
		return
	}

	keyID, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || keyID <= 0 {
		errors.WriteError(w, errors.BadRequest("invalid ssh key id"))
		return
	}

	if err := h.Service.DeleteKey(r.Context(), user.ID, keyID); err != nil {
		writeRouteError(w, r, err)
		return
	}

	if h.AuditService != nil {
		h.AuditService.Log(r.Context(), services.AuditEvent{
			EventType:  "ssh_key.delete",
			ActorID:    &user.ID,
			ActorName:  user.Username,
			TargetType: "ssh_key",
			TargetID:   &keyID,
			TargetName: fmt.Sprintf("key_%d", keyID),
			Action:     "delete",
			IPAddress:  r.RemoteAddr,
		})
	}

	w.WriteHeader(http.StatusNoContent)
}
