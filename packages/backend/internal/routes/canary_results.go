package routes

import (
	"net/http"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type CanaryResultStore = services.CanaryResultStore

type CanaryReportHandler struct {
	Store CanaryResultStore
	Clock func() time.Time
}

type canaryReportRequest = services.CanaryReportInput

func (h *CanaryReportHandler) now() time.Time {
	if h != nil && h.Clock != nil {
		return h.Clock().UTC()
	}
	return time.Now().UTC()
}

func (h *CanaryReportHandler) PostResults(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.Store == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("canary result store unavailable"))
		return
	}

	var req canaryReportRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	if err := services.NewCanaryReportService(h.Store).ReportResults(r.Context(), req, h.now()); err != nil {
		writeRouteError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusAccepted)
}
