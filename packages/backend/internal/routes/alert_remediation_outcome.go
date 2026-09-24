package routes

import (
	"github.com/smithersai/smithers/packages/backend/internal/clusterservices"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const maxAlertRemediationOutcomeBodyBytes = 64 << 10

// AlertWorkflowOutcomeRecorder authorizes the verified workflow run against a
// durable remediation job before changing its incident.
type AlertWorkflowOutcomeRecorder interface {
	RecordWorkflowRemediationOutcome(ctx context.Context, run db.WorkflowRun, claim clusterservices.AlertRemediationTaskClaim, outcome clusterservices.AlertRemediationOutcome) error
}

// AlertRemediationOutcomeHandler receives callbacks from the exact running
// remediation task. It deliberately does not use the global inbound-monitoring
// HMAC token: that secret remains confined to the API process.
type AlertRemediationOutcomeHandler struct {
	Recorder AlertWorkflowOutcomeRecorder
}

type alertRemediationOutcomeBody struct {
	State     string `json:"state"`
	PrURL     string `json:"pr_url"`
	ReportURL string `json:"report_url"`
}

// Record handles POST /internal/alerts/incidents/{incident-id}/outcome after
// RequireAgentToken has authenticated a currently running task-scoped token.
func (h *AlertRemediationOutcomeHandler) Record(w http.ResponseWriter, r *http.Request) {
	claims, taskScoped := middleware.RunnerTaskTokenFromContext(r.Context())
	run := middleware.WorkflowRunFromContext(r.Context())
	if !taskScoped || run == nil || claims.TaskID <= 0 || claims.RunnerID <= 0 || claims.Attempt <= 0 ||
		claims.WorkflowRunID != run.ID || claims.RepositoryID != run.RepositoryID {
		pkgerrors.WriteError(w, pkgerrors.Forbidden("a running remediation task token is required"))
		return
	}
	incidentID := strings.TrimSpace(chi.URLParam(r, "incident-id"))
	if incidentID == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("alert incident id is required"))
		return
	}
	if h == nil || h.Recorder == nil {
		pkgerrors.WriteError(w, pkgerrors.NotFound("alert remediation outcome receiver is not configured"))
		return
	}

	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxAlertRemediationOutcomeBodyBytes))
	decoder.DisallowUnknownFields()
	var body alertRemediationOutcomeBody
	if err := decoder.Decode(&body); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid remediation outcome payload"))
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid remediation outcome payload"))
		return
	}

	err := h.Recorder.RecordWorkflowRemediationOutcome(r.Context(), *run, clusterservices.AlertRemediationTaskClaim{
		TaskID:   claims.TaskID,
		RunnerID: claims.RunnerID,
		Attempt:  claims.Attempt,
	}, clusterservices.AlertRemediationOutcome{
		IncidentID: incidentID,
		State:      body.State,
		PrURL:      body.PrURL,
		ReportURL:  body.ReportURL,
	})
	if err != nil {
		var apiErr *pkgerrors.APIError
		if errors.As(err, &apiErr) {
			pkgerrors.WriteError(w, apiErr)
		} else {
			writeInternalError(w, r, "failed to record remediation outcome", err)
		}
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
