package routes

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
)

func TestAgentSessionStream_H_StreamConfigAndReplayBranches(t *testing.T) {
	oldServe := serveAgentSessionBrokerSSE
	t.Cleanup(func() { serveAgentSessionBrokerSSE = oldServe })

	var gotCfg sse.BrokerStreamConfig
	serveAgentSessionBrokerSSE = func(w http.ResponseWriter, r *http.Request, cfg sse.BrokerStreamConfig) {
		gotCfg = cfg
		cfg.OnConnect(w, r, httptest.NewRecorder())
		w.WriteHeader(http.StatusAccepted)
	}

	svc := &agentSessionStreamCovService{messages: []services.AgentMessageResponse{{
		ID:        22,
		SessionID: "abc-123",
		Role:      "assistant",
		Sequence:  2,
		CreatedAt: time.Date(2026, 7, 7, 1, 2, 3, 0, time.UTC),
	}}}
	h := &AgentSessionStreamHandler{
		Service: svc,
		Broker:  &sse.Broker{},
		Metrics: &SmithersMetrics{SSEActiveConnections: prometheus.NewGauge(prometheus.GaugeOpts{Name: "agent_session_stream_h_active"})},
	}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/agent/sessions/abc-123/stream", nil)
	req.Header.Set("Last-Event-ID", "21")
	req = withRouteParams(req, map[string]string{"id": "abc-123"})
	req = withAuth(req, 7, "alice")
	req = withRepoCtx(req, 101, "owner", "repo")
	rec := httptest.NewRecorder()

	h.AgentSessionStream(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "agent_session_abc123", gotCfg.Channel)
	assert.Equal(t, int64(7), gotCfg.UserID)
	assert.Equal(t, "agent.session", gotCfg.EventType)
	assert.NotNil(t, gotCfg.ActiveConnections)
	assert.Contains(t, rec.Body.String(), "id: 22")
	assert.True(t, svc.called)
}

func TestAgentSessionStream_H_ReplayMarshalErrorAndIDs(t *testing.T) {
	oldMarshal := marshalAgentSessionReplayPayload
	t.Cleanup(func() { marshalAgentSessionReplayPayload = oldMarshal })
	marshalAgentSessionReplayPayload = func(any) ([]byte, error) {
		return nil, errors.New("marshal failed")
	}

	svc := &agentSessionStreamCovService{messages: []services.AgentMessageResponse{{
		ID:        31,
		SessionID: "s",
		Role:      "assistant",
		CreatedAt: time.Now().UTC(),
	}}}
	req := httptest.NewRequest(http.MethodGet, "/stream", nil)
	req.Header.Set("Last-Event-ID", "30")
	rec := httptest.NewRecorder()

	(&AgentSessionStreamHandler{Service: svc}).replayAgentSessionEvents(rec, req, rec, "s")

	assert.Contains(t, rec.Body.String(), "event: stream.error")
	assert.NotContains(t, rec.Body.String(), "id:")
	assert.True(t, rec.Flushed)

	assert.Empty(t, extractAgentEventID(`not-json`))
	assert.Equal(t, "1", extractAgentEventID(`{"id":1}`))
	assert.Equal(t, "2", extractAgentEventID(`{"sequence":2}`))
	assert.Equal(t, "3", extractAgentEventID(`{"message":{"id":3}}`))
	assert.Equal(t, "4", extractAgentEventID(`{"message":{"sequence":4}}`))
	assert.Empty(t, extractAgentEventID(`{"message":{}}`))
}

func TestAgentSessionStream_H_ServiceNilStillBuildsStream(t *testing.T) {
	oldServe := serveAgentSessionBrokerSSE
	t.Cleanup(func() { serveAgentSessionBrokerSSE = oldServe })

	called := false
	serveAgentSessionBrokerSSE = func(w http.ResponseWriter, r *http.Request, cfg sse.BrokerStreamConfig) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/repos/owner/repo/agent/sessions/abc/stream", nil)
	req = withRouteParams(req, map[string]string{"id": "abc"})
	req = withAuth(req, 7, "alice")
	req = withRepoInContext(req, &db.Repository{ID: 101, Name: "repo"})
	rec := httptest.NewRecorder()

	(&AgentSessionStreamHandler{Broker: &sse.Broker{}}).AgentSessionStream(rec, req)

	require.True(t, called)
	require.Equal(t, http.StatusNoContent, rec.Code)
}
