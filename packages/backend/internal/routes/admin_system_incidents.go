package routes

import (
	"github.com/smithersai/smithers/packages/backend/internal/clusterservices"
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// adminSystemIncidentsQueryTimeout bounds the incident listing queries,
// matching the sibling admin system endpoints.
const adminSystemIncidentsQueryTimeout = 5 * time.Second

// AdminSystemIncidentsRouteService is the service contract for the admin
// system incidents endpoint.
type AdminSystemIncidentsRouteService interface {
	ListIncidents(ctx context.Context, input clusterservices.AdminSystemIncidentListInput) ([]clusterservices.AdminSystemIncident, error)
}

type AdminIncidentsRouteService interface {
	Acknowledge(context.Context, int64, *string) (clusterservices.AdminSystemIncident, error)
	Unacknowledge(context.Context, int64) (clusterservices.AdminSystemIncident, error)
	Resolve(context.Context, int64, *string) (clusterservices.AdminSystemIncident, error)
	Snooze(context.Context, int64, time.Time) (clusterservices.AdminSystemIncident, error)
	Bulk(context.Context, clusterservices.AdminIncidentBulkInput) (int64, error)
}

// AdminSystemIncidentsHandler handles GET /api/admin/system/incidents.
type AdminSystemIncidentsHandler struct {
	Service AdminSystemIncidentsRouteService
	Actions AdminIncidentsRouteService
}

// systemIncidentRemediationResponse is one remediation attempt attached to an
// incident. workflow_run_id is serialized as a string so JavaScript clients
// cannot silently round a bigint through float64.
type systemIncidentRemediationResponse struct {
	ID            int64     `json:"id"`
	State         string    `json:"state"`
	Attempts      int32     `json:"attempts"`
	WorkflowRunID *string   `json:"workflow_run_id"`
	UpdatedAt     time.Time `json:"updated_at"`
}

// systemIncidentResponse is one alert incident with its remediation attempts.
type systemIncidentResponse struct {
	ID             int64                               `json:"id"`
	IncidentID     string                              `json:"incident_id"`
	Condition      string                              `json:"condition"`
	Source         string                              `json:"source"`
	URL            string                              `json:"url"`
	Runbook        string                              `json:"runbook"`
	Occurrences    int32                               `json:"occurrences"`
	LastSeenAt     time.Time                           `json:"last_seen_at"`
	AcknowledgedAt *time.Time                          `json:"acknowledged_at"`
	AcknowledgedBy *string                             `json:"acknowledged_by"`
	SnoozedUntil   *time.Time                          `json:"snoozed_until"`
	ResolvedBy     *string                             `json:"resolved_by"`
	ResolutionNote *string                             `json:"resolution_note"`
	Policy         string                              `json:"policy"`
	State          string                              `json:"state"`
	OpenedAt       time.Time                           `json:"opened_at"`
	ClosedAt       *time.Time                          `json:"closed_at"`
	Summary        string                              `json:"summary"`
	Remediations   []systemIncidentRemediationResponse `json:"remediations"`
}

type systemIncidentsResponse struct {
	Incidents []systemIncidentResponse `json:"incidents"`
}

func toSystemIncidentResponse(inc clusterservices.AdminSystemIncident) systemIncidentResponse {
	// pgx decodes timestamptz into the server's local zone; normalize to UTC so
	// every admin system endpoint serializes the same instant identically.
	resp := systemIncidentResponse{
		ID:         inc.ID,
		IncidentID: inc.IncidentID, Condition: inc.Condition, Source: inc.Source,
		URL: inc.URL, Runbook: inc.Runbook, Occurrences: inc.Occurrences, LastSeenAt: inc.LastSeenAt.UTC(),
		AcknowledgedAt: incidentResponseTime(inc.AcknowledgedAt), AcknowledgedBy: inc.AcknowledgedBy,
		SnoozedUntil: incidentResponseTime(inc.SnoozedUntil), ResolvedBy: inc.ResolvedBy, ResolutionNote: inc.ResolutionNote,
		Policy:       inc.Policy,
		State:        inc.State,
		OpenedAt:     inc.OpenedAt.UTC(),
		Summary:      inc.Summary,
		Remediations: make([]systemIncidentRemediationResponse, len(inc.Remediations)),
	}
	if inc.ClosedAt != nil {
		closedAt := inc.ClosedAt.UTC()
		resp.ClosedAt = &closedAt
	}
	for i, rem := range inc.Remediations {
		item := systemIncidentRemediationResponse{
			ID:        rem.ID,
			State:     rem.State,
			Attempts:  rem.Attempts,
			UpdatedAt: rem.UpdatedAt.UTC(),
		}
		if rem.WorkflowRunID != nil {
			runID := strconv.FormatInt(*rem.WorkflowRunID, 10)
			item.WorkflowRunID = &runID
		}
		resp.Remediations[i] = item
	}
	return resp
}

// parseSystemIncidentsQuery validates the query string for
// GET /api/admin/system/incidents.
func parseSystemIncidentsQuery(r *http.Request) (clusterservices.AdminSystemIncidentListInput, *pkgerrors.APIError) {
	input := clusterservices.AdminSystemIncidentListInput{
		State:  services.AdminSystemIncidentStateActive,
		Policy: r.URL.Query().Get("policy"),
		Limit:  services.AdminSystemIncidentDefaultLimit,
	}

	if raw := strings.TrimSpace(r.URL.Query().Get("state")); raw != "" {
		if !clusterservices.ValidAdminIncidentState(raw) {
			return input, pkgerrors.BadRequest("invalid incident state")
		}
		input.State = raw
	}

	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > services.AdminSystemIncidentMaxLimit {
			return input, pkgerrors.BadRequest("invalid limit: must be between 1 and 200")
		}
		input.Limit = limit
	}

	return input, nil
}

// ListIncidents handles GET /api/admin/system/incidents.
// Requires: authenticated admin user.
// Query params: lifecycle state (default active), exact policy, limit (default 50, max 200).
func (h *AdminSystemIncidentsHandler) ListIncidents(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.Service == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("incident service unavailable"))
		return
	}

	input, apiErr := parseSystemIncidentsQuery(r)
	if apiErr != nil {
		pkgerrors.WriteError(w, apiErr)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), adminSystemIncidentsQueryTimeout)
	defer cancel()

	incidents, err := h.Service.ListIncidents(ctx, input)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}

	resp := systemIncidentsResponse{Incidents: make([]systemIncidentResponse, len(incidents))}
	for i, inc := range incidents {
		resp.Incidents[i] = toSystemIncidentResponse(inc)
	}

	pkgerrors.WriteJSON(w, http.StatusOK, resp)
}

func incidentResponseTime(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	utc := t.UTC()
	return &utc
}

type incidentNoteRequest struct {
	Note *string `json:"note"`
}

func (h *AdminSystemIncidentsHandler) Acknowledge(w http.ResponseWriter, r *http.Request) {
	h.mutate(w, r, "acknowledge")
}
func (h *AdminSystemIncidentsHandler) Unacknowledge(w http.ResponseWriter, r *http.Request) {
	h.mutate(w, r, "unacknowledge")
}
func (h *AdminSystemIncidentsHandler) Resolve(w http.ResponseWriter, r *http.Request) {
	h.mutate(w, r, "resolve")
}
func (h *AdminSystemIncidentsHandler) Snooze(w http.ResponseWriter, r *http.Request) {
	h.mutate(w, r, "snooze")
}

func (h *AdminSystemIncidentsHandler) mutate(w http.ResponseWriter, r *http.Request, action string) {
	if h == nil || h.Actions == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("incident service unavailable"))
		return
	}
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id <= 0 {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid incident id"))
		return
	}
	ctx, cancel := context.WithTimeout(adminUserAuditContext(r), adminSystemIncidentsQueryTimeout)
	defer cancel()
	var result clusterservices.AdminSystemIncident
	switch action {
	case "acknowledge", "resolve":
		var input incidentNoteRequest
		if !decodeOptionalJSONBody(w, r, &input) {
			return
		}
		if action == "acknowledge" {
			result, err = h.Actions.Acknowledge(ctx, id, input.Note)
		} else {
			result, err = h.Actions.Resolve(ctx, id, input.Note)
		}
	case "unacknowledge":
		result, err = h.Actions.Unacknowledge(ctx, id)
	case "snooze":
		var input struct {
			Until time.Time `json:"until"`
		}
		if !decodeJSONBody(w, r, &input) {
			return
		}
		result, err = h.Actions.Snooze(ctx, id, input.Until)
	}
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, toSystemIncidentResponse(result))
}

func (h *AdminSystemIncidentsHandler) Bulk(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.Actions == nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("incident service unavailable"))
		return
	}
	var input clusterservices.AdminIncidentBulkInput
	if !decodeJSONBody(w, r, &input) {
		return
	}
	ctx, cancel := context.WithTimeout(adminUserAuditContext(r), adminSystemIncidentsQueryTimeout)
	defer cancel()
	affected, err := h.Actions.Bulk(ctx, input)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	pkgerrors.WriteJSON(w, http.StatusOK, struct {
		Affected int64 `json:"affected"`
	}{affected})
}
