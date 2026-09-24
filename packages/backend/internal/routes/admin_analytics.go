package routes

import (
	"context"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/clusterservices"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type AdminAnalyticsRouteService interface {
	Summary(context.Context, string, bool) (clusterservices.AnalyticsSummary, error)
}
type AdminAnalyticsHandler struct{ Service AdminAnalyticsRouteService }

func (h *AdminAnalyticsHandler) Summary(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	rangeName := "30d"
	if values, ok := query["range"]; ok {
		if len(values) != 1 {
			pkgerrors.WriteError(w, pkgerrors.BadRequest("range must be specified once"))
			return
		}
		rangeName = values[0]
	}
	if _, err := clusterservices.AnalyticsRangeDays(rangeName); err != nil {
		writeRouteError(w, r, err)
		return
	}
	includeSynthetic := false
	if values, ok := query["include_synthetic"]; ok {
		if len(values) != 1 || (values[0] != "true" && values[0] != "false") {
			pkgerrors.WriteError(w, pkgerrors.BadRequest("include_synthetic must be true or false"))
			return
		}
		includeSynthetic = values[0] == "true"
	}
	summary, err := h.Service.Summary(r.Context(), rangeName, includeSynthetic)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, summary)
}
