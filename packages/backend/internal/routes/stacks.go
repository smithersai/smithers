package routes

import (
	"context"
	"net/http"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type StackRouteService interface {
	GetActiveStack(ctx context.Context, viewer *db.User, owner, repo, targetRef string) (services.StackResponse, error)
	UpsertActiveStack(ctx context.Context, actor *db.User, owner, repo string, input services.UpsertActiveStackInput) (services.StackResponse, error)
	DeleteActiveStack(ctx context.Context, actor *db.User, owner, repo, targetRef string) error
}

type StackHandler struct {
	Service StackRouteService
}

type upsertActiveStackRequest struct {
	Changes   []services.StackChangeInput `json:"changes"`
	TargetRef string                      `json:"target_ref"`
}

func (h *StackHandler) GetActiveStack(w http.ResponseWriter, r *http.Request) {
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
	targetRef := strings.TrimSpace(r.URL.Query().Get("target_ref"))

	stack, svcErr := h.Service.GetActiveStack(r.Context(), user, owner, repo, targetRef)
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	errors.WriteJSON(w, http.StatusOK, stack)
}

func (h *StackHandler) UpsertActiveStack(w http.ResponseWriter, r *http.Request) {
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

	var req upsertActiveStackRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	stack, svcErr := h.Service.UpsertActiveStack(r.Context(), user, owner, repo, services.UpsertActiveStackInput{
		Changes:   req.Changes,
		TargetRef: req.TargetRef,
	})
	if svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	errors.WriteJSON(w, http.StatusOK, stack)
}

func (h *StackHandler) DeleteActiveStack(w http.ResponseWriter, r *http.Request) {
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
	targetRef := strings.TrimSpace(r.URL.Query().Get("target_ref"))

	if svcErr := h.Service.DeleteActiveStack(r.Context(), user, owner, repo, targetRef); svcErr != nil {
		writeRouteError(w, r, svcErr)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
