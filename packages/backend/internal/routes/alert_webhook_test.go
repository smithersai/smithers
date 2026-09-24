package routes_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/clusterservices"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/routes"
)

type stubAlertIncidentReceiver struct {
	incidents []clusterservices.MonitoringAlertIncident
	err       error
}

func (s *stubAlertIncidentReceiver) HandleAlertIncident(_ context.Context, incident clusterservices.MonitoringAlertIncident) error {
	if s.err != nil {
		return s.err
	}
	s.incidents = append(s.incidents, incident)
	return nil
}

func alertWebhookRouter(handler *routes.AlertWebhookHandler) *chi.Mux {
	r := chi.NewRouter()
	r.Post("/api/internal/alerts/incident", handler.Receive)
	return r
}

func setAlertWebhookAuth(req *http.Request, password string) {
	req.SetBasicAuth(routes.AlertWebhookBasicAuthUsername, password)
}

func TestAlertWebhookHandler_NewReturnsNilForEmptyKey(t *testing.T) {
	t.Parallel()

	assert.Nil(t, routes.NewAlertWebhookHandler(""))
	assert.Nil(t, routes.NewAlertWebhookHandler("   "))
}

func TestAlertWebhookHandler_BasicAuthValidation(t *testing.T) {
	t.Parallel()

	assert.True(t, routes.ValidateAlertWebhookBasicAuth("key-a", routes.AlertWebhookBasicAuthUsername, "key-a"))
	assert.False(t, routes.ValidateAlertWebhookBasicAuth("key-b", routes.AlertWebhookBasicAuthUsername, "key-a"))
	assert.False(t, routes.ValidateAlertWebhookBasicAuth("key-a", "wrong-user", "key-a"))
	assert.False(t, routes.ValidateAlertWebhookBasicAuth("", routes.AlertWebhookBasicAuthUsername, "key-a"))
}

func TestAlertWebhookHandler_Receive_InvalidTokenReturns401(t *testing.T) {
	t.Parallel()

	handler := routes.NewAlertWebhookHandler("signing-key")
	require.NotNil(t, handler)

	req := httptest.NewRequest(http.MethodPost, "/api/internal/alerts/incident", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	alertWebhookRouter(handler).ServeHTTP(rec, req)

	assert.Equal(t, http.StatusUnauthorized, rec.Code)
	assert.Contains(t, rec.Header().Get("WWW-Authenticate"), "Basic")
}

func TestAlertWebhookHandler_Receive_InvalidJSONReturns400(t *testing.T) {
	t.Parallel()

	handler := routes.NewAlertWebhookHandler("signing-key")
	req := httptest.NewRequest(http.MethodPost, "/api/internal/alerts/incident", strings.NewReader(`not-json`))
	setAlertWebhookAuth(req, "signing-key")
	rec := httptest.NewRecorder()
	alertWebhookRouter(handler).ServeHTTP(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestAlertWebhookHandler_Receive_MissingIncidentIDReturns400(t *testing.T) {
	t.Parallel()

	handler := routes.NewAlertWebhookHandler("signing-key")
	req := httptest.NewRequest(http.MethodPost, "/api/internal/alerts/incident",
		strings.NewReader(`{"incident": {"policy_name": "Smithers High Error Rate - prod"}}`))
	setAlertWebhookAuth(req, "signing-key")
	rec := httptest.NewRecorder()
	alertWebhookRouter(handler).ServeHTTP(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestAlertWebhookHandler_Receive_InvalidStateReturns400(t *testing.T) {
	t.Parallel()
	receiver := &stubAlertIncidentReceiver{}
	handler := routes.NewAlertWebhookHandler("signing-key")
	handler.Receiver = receiver
	req := httptest.NewRequest(http.MethodPost, "/api/internal/alerts/incident",
		strings.NewReader(`{"incident":{"incident_id":"0.invalid","state":"firing"}}`))
	setAlertWebhookAuth(req, "signing-key")
	rec := httptest.NewRecorder()
	alertWebhookRouter(handler).ServeHTTP(rec, req)

	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.Empty(t, receiver.incidents)
}

func TestAlertWebhookHandler_Receive_NotReadyReturns503(t *testing.T) {
	t.Parallel()

	handler := routes.NewAlertWebhookHandler("signing-key")
	req := httptest.NewRequest(http.MethodPost, "/api/internal/alerts/incident",
		strings.NewReader(`{"incident":{"incident_id":"0.not-ready","state":"open"}}`))
	setAlertWebhookAuth(req, "signing-key")
	rec := httptest.NewRecorder()
	alertWebhookRouter(handler).ServeHTTP(rec, req)

	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
	assert.Contains(t, rec.Body.String(), "worker is not ready")
}

func TestAlertWebhookHandler_Receive_ValidPayloadReturns204AndForwardsIncident(t *testing.T) {
	t.Parallel()

	receiver := &stubAlertIncidentReceiver{}
	handler := routes.NewAlertWebhookHandler("signing-key")
	handler.Receiver = receiver
	body := `{
		"incident": {
			"incident_id": "0.abcdef",
			"policy_name": "Smithers High Error Rate - prod",
			"condition_name": "5xx rate",
			"state": "OPEN",
			"summary": "error rate above threshold",
			"url": "https://console.cloud.google.com/incident/1"
		}
	}`
	req := httptest.NewRequest(http.MethodPost, "/api/internal/alerts/incident", strings.NewReader(body))
	setAlertWebhookAuth(req, "signing-key")
	rec := httptest.NewRecorder()
	alertWebhookRouter(handler).ServeHTTP(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	require.Len(t, receiver.incidents, 1)
	incident := receiver.incidents[0]
	assert.Equal(t, "0.abcdef", incident.IncidentID)
	assert.Equal(t, "Smithers High Error Rate - prod", incident.PolicyName)
	assert.Equal(t, "5xx rate", incident.ConditionName)
	assert.Equal(t, "open", incident.State, "state must be lowercased")
	assert.Equal(t, "error rate above threshold", incident.Summary)
	assert.Equal(t, "https://console.cloud.google.com/incident/1", incident.URL)
}
