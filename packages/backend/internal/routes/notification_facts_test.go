package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
)

type notificationFactRouteMock struct {
	*mockNotificationRouteService
	facts func(context.Context, int64, int64, int) (services.NotificationFactPage, error)
}

func (m *notificationFactRouteMock) ListNotificationFacts(ctx context.Context, user, after int64, limit int) (services.NotificationFactPage, error) {
	return m.facts(ctx, user, after, limit)
}

func TestNotificationFactsRouteScopesAndValidates(t *testing.T) {
	called := false
	handler := &NotificationHandler{Service: &notificationFactRouteMock{mockNotificationRouteService: &mockNotificationRouteService{}, facts: func(_ context.Context, user, after int64, limit int) (services.NotificationFactPage, error) {
		called = true
		require.Equal(t, int64(7), user)
		require.Equal(t, int64(2), after)
		require.Equal(t, 17, limit)
		return services.NotificationFactPage{SchemaVersion: 1, StreamID: "notifications:7", Cursor: 2, Head: 2, Events: []services.NotificationFact{}, Coverage: services.NotificationFactCoverage{Kind: "legacy_snapshot"}}, nil
	}}}
	unauth := httptest.NewRecorder()
	handler.ListNotificationFacts(unauth, httptest.NewRequest(http.MethodGet, "/api/notifications/events", nil))
	require.Equal(t, http.StatusUnauthorized, unauth.Code)
	require.False(t, called)
	for _, query := range []string{"after=-1", "after=bad", "limit=0", "limit=1001"} {
		rec := httptest.NewRecorder()
		handler.ListNotificationFacts(rec, withAuth(httptest.NewRequest(http.MethodGet, "/api/notifications/events?"+query, nil), 7, "alice"))
		require.Equal(t, http.StatusBadRequest, rec.Code)
		require.False(t, called)
	}
	rec := httptest.NewRecorder()
	handler.ListNotificationFacts(rec, withAuth(httptest.NewRequest(http.MethodGet, "/api/notifications/events?after=2&limit=17&user_id=99", nil), 7, "alice"))
	require.Equal(t, http.StatusOK, rec.Code)
	require.True(t, called)
	require.Contains(t, rec.Body.String(), `"stream_id":"notifications:7"`)
}

func TestNotificationFactsStreamSupportsBaselineResumeAndVisibilityReset(t *testing.T) {
	original := serveNotificationBrokerSSE
	t.Cleanup(func() { serveNotificationBrokerSSE = original })
	serveNotificationBrokerSSE = func(w http.ResponseWriter, r *http.Request, cfg sse.BrokerStreamConfig) {
		require.Equal(t, "notification_facts_7", cfg.Channel)
		cfg.OnConnect(w, r, w.(http.Flusher))
	}
	for _, resume := range []bool{false, true} {
		t.Run(map[bool]string{false: "baseline", true: "resume"}[resume], func(t *testing.T) {
			handler := &NotificationHandler{Service: &notificationFactRouteMock{mockNotificationRouteService: &mockNotificationRouteService{}, facts: func(_ context.Context, user, after int64, _ int) (services.NotificationFactPage, error) {
				page := services.NotificationFactPage{SchemaVersion: 1, StreamID: "notifications:7", Cursor: after, Head: 3, Events: []services.NotificationFact{}}
				if after >= 3 {
					return page, nil
				}
				page.Cursor = 3
				page.VisibilityFiltered = true
				if !resume {
					page.Events = []services.NotificationFact{{ID: uuid.NewString(), StreamID: "notifications:7", Sequence: 2, SchemaVersion: 1, Type: "notification.baseline", NotificationID: 9, RecordedAt: time.Now().UTC(), Notification: &services.NotificationResponse{ID: 9, Status: "read"}}}
				}
				return page, nil
			}}}
			req := withAuth(httptest.NewRequest(http.MethodGet, "/api/notifications/events/stream?after=0", nil), 7, "alice")
			if resume {
				req.Header.Set("Last-Event-ID", "1")
			}
			rec := httptest.NewRecorder()
			handler.NotificationFactsStream(rec, req)
			require.NotContains(t, rec.Body.String(), "stream.error")
			if resume {
				require.Contains(t, rec.Body.String(), "event: notification.reset")
				require.NotContains(t, rec.Body.String(), "notification_id")
			} else {
				require.Contains(t, rec.Body.String(), "event: notification.fact")
				require.Contains(t, rec.Body.String(), "notification.baseline")
				require.Contains(t, rec.Body.String(), "id: 3\nevent: notification.cursor")
			}
		})
	}
}

func TestNotificationFactWireKeepsSeparateEventAndNotificationIdentities(t *testing.T) {
	fact := services.NotificationFact{ID: uuid.NewString(), StreamID: "notifications:7", Sequence: 12, SchemaVersion: 1, Type: "notification.read", NotificationID: 99, RecordedAt: time.Now().UTC(), Notification: &services.NotificationResponse{ID: 99, Status: "read"}}
	data, err := json.Marshal(fact)
	require.NoError(t, err)
	var decoded map[string]any
	require.NoError(t, json.Unmarshal(data, &decoded))
	require.Equal(t, fact.ID, decoded["id"])
	require.Equal(t, float64(12), decoded["sequence"])
	require.Equal(t, float64(99), decoded["notification_id"])
}
