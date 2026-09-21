package routes

import (
	"context"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type landingAppendObserver interface {
	ObserveLandingAppend(context.Context, *db.User, string, string, int64) (services.LandingAppendObservation, error)
}

func (h *LandingHandler) ObserveLandingAppend(w http.ResponseWriter, r *http.Request) {
	owner, repo, number, err := landingRouteContext(r)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	observer, ok := h.Service.(landingAppendObserver)
	if !ok {
		errors.WriteError(w, errors.New(errors.CodeAppendReceiptUnavailable, "append receipt observation is unavailable"))
		return
	}
	result, err := observer.ObserveLandingAppend(r.Context(), middleware.UserFromContext(r.Context()), owner, repo, number)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, result)
}
