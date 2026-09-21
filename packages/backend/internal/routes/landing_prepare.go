package routes

import (
	"context"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type landingAppendPreparer interface {
	PrepareLandingAppend(context.Context, *db.User, string, string, repohost.AppendPreparationRequest) (services.LandingAppendPreparation, error)
}

func (h *LandingHandler) PrepareLandingAppend(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	service, ok := h.Service.(landingAppendPreparer)
	if !ok {
		errors.WriteError(w, errors.New(errors.CodeAppendPrepareUnavailable, "native append preparation is unavailable"))
		return
	}
	var request repohost.AppendPreparationRequest
	if !decodeJSONBody(w, r, &request) {
		return
	}
	result, err := service.PrepareLandingAppend(r.Context(), actor, owner, repo, request)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, result)
}
