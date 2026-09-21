package routes

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const (
	AlertWebhookBasicAuthUsername = "smithers-alert-webhook"

	// maxAlertWebhookBodyBytes caps the Cloud Monitoring webhook payload size.
	maxAlertWebhookBodyBytes = 25 << 20
)

// AlertIncidentReceiver handles a parsed monitoring alert incident (implemented
// by services.AlertIncidentService).
type AlertIncidentReceiver interface {
	HandleAlertIncident(ctx context.Context, incident services.MonitoringAlertIncident) error
}

// AlertWebhookHandler receives GCP Cloud Monitoring webhook_basicauth
// notifications on POST /api/internal/alerts/incident. Keeping the credential
// in Authorization prevents traces, proxies, and load-balancer access logs
// from persisting a write-impacting bearer in the URL.
type AlertWebhookHandler struct {
	signingKey []byte
	Receiver   AlertIncidentReceiver
}

// NewAlertWebhookHandler returns nil when no signing key is configured, in
// which case the route responds 404 (receiver not configured).
func NewAlertWebhookHandler(signingKey string) *AlertWebhookHandler {
	signingKey = strings.TrimSpace(signingKey)
	if signingKey == "" {
		return nil
	}
	return &AlertWebhookHandler{signingKey: []byte(signingKey)}
}

// ValidateAlertWebhookBasicAuth validates Cloud Monitoring's fixed username
// and secret password without comparing the variable-length secret directly.
func ValidateAlertWebhookBasicAuth(signingKey, username, password string) bool {
	signingKey = strings.TrimSpace(signingKey)
	if signingKey == "" {
		return false
	}
	expectedUser := sha256.Sum256([]byte(AlertWebhookBasicAuthUsername))
	actualUser := sha256.Sum256([]byte(username))
	expectedPassword := sha256.Sum256([]byte(signingKey))
	actualPassword := sha256.Sum256([]byte(password))
	return subtle.ConstantTimeCompare(expectedUser[:], actualUser[:]) == 1 &&
		subtle.ConstantTimeCompare(expectedPassword[:], actualPassword[:]) == 1
}

// gcpMonitoringWebhookPayload matches the Cloud Monitoring webhook JSON schema.
type gcpMonitoringWebhookPayload struct {
	Incident *struct {
		IncidentID    string `json:"incident_id"`
		PolicyName    string `json:"policy_name"`
		ConditionName string `json:"condition_name"`
		State         string `json:"state"`
		Summary       string `json:"summary"`
		URL           string `json:"url"`
	} `json:"incident"`
}

// Receive handles POST /api/internal/alerts/incident.
func (h *AlertWebhookHandler) Receive(w http.ResponseWriter, r *http.Request) {
	if h == nil || len(h.signingKey) == 0 {
		pkgerrors.WriteError(w, pkgerrors.NotFound("alert webhook receiver is not configured"))
		return
	}
	username, password, ok := r.BasicAuth()
	if !ok || !ValidateAlertWebhookBasicAuth(string(h.signingKey), username, password) {
		w.Header().Set("WWW-Authenticate", `Basic realm="smithers-alert-webhook", charset="UTF-8"`)
		pkgerrors.WriteError(w, pkgerrors.Unauthorized("invalid alert webhook credentials"))
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxAlertWebhookBodyBytes))
	if err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("failed to read alert webhook payload"))
		return
	}

	var payload gcpMonitoringWebhookPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid alert webhook payload"))
		return
	}
	if payload.Incident == nil || strings.TrimSpace(payload.Incident.IncidentID) == "" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("alert webhook payload is missing incident.incident_id"))
		return
	}

	incident := services.MonitoringAlertIncident{
		IncidentID:    strings.TrimSpace(payload.Incident.IncidentID),
		PolicyName:    strings.TrimSpace(payload.Incident.PolicyName),
		ConditionName: strings.TrimSpace(payload.Incident.ConditionName),
		State:         strings.ToLower(strings.TrimSpace(payload.Incident.State)),
		Summary:       strings.TrimSpace(payload.Incident.Summary),
		URL:           strings.TrimSpace(payload.Incident.URL),
	}
	if incident.State != "open" && incident.State != "closed" {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("alert webhook incident.state must be open or closed"))
		return
	}

	if h.Receiver == nil {
		pkgerrors.WriteError(w, pkgerrors.New(pkgerrors.CodeServiceUnavailable,
			"alert remediation worker is not ready"))
		return
	}
	if err := h.Receiver.HandleAlertIncident(r.Context(), incident); err != nil {
		pkgerrors.WriteError(w, pkgerrors.Internal("failed to process alert incident"))
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
