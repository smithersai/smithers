package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/clusterservices"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type mockAdminSystemIncidentsService struct {
	listIncidentsFn func(ctx context.Context, input clusterservices.AdminSystemIncidentListInput) ([]clusterservices.AdminSystemIncident, error)
}

func (m *mockAdminSystemIncidentsService) ListIncidents(ctx context.Context, input clusterservices.AdminSystemIncidentListInput) ([]clusterservices.AdminSystemIncident, error) {
	if m.listIncidentsFn != nil {
		return m.listIncidentsFn(ctx, input)
	}
	return []clusterservices.AdminSystemIncident{}, nil
}

func doSystemIncidentsRequest(h *AdminSystemIncidentsHandler, target string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, target, nil)
	req = withAdminContext(req)
	rec := httptest.NewRecorder()
	h.ListIncidents(rec, req)
	return rec
}

func TestAdminSystemIncidentsHandler_ListIncidents(t *testing.T) {
	t.Parallel()

	opened := time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC)
	closed := opened.Add(30 * time.Minute)

	t.Run("returns incidents with remediations attached", func(t *testing.T) {
		t.Parallel()

		runID := int64(918273645)
		h := &AdminSystemIncidentsHandler{
			Service: &mockAdminSystemIncidentsService{
				listIncidentsFn: func(_ context.Context, input clusterservices.AdminSystemIncidentListInput) ([]clusterservices.AdminSystemIncident, error) {
					assert.Equal(t, clusterservices.AdminSystemIncidentStateActive, input.State)
					assert.Equal(t, 50, input.Limit)
					return []clusterservices.AdminSystemIncident{
						{
							ID:       2,
							Policy:   "queue-depth",
							State:    "remediating",
							OpenedAt: opened,
							Summary:  "workflow queue backing up",
							Remediations: []clusterservices.AdminSystemRemediation{
								{ID: 10, State: "processing", Attempts: 2, WorkflowRunID: &runID, UpdatedAt: closed},
								{ID: 11, State: "failed", Attempts: 1, UpdatedAt: opened},
							},
						},
						{
							ID:           1,
							Policy:       "api-5xx",
							State:        "resolved",
							OpenedAt:     opened.Add(-time.Hour),
							ClosedAt:     &closed,
							Summary:      "5xx rate above threshold",
							Remediations: []clusterservices.AdminSystemRemediation{},
						},
					}, nil
				},
			},
		}

		rec := doSystemIncidentsRequest(h, "/api/admin/system/incidents")
		require.Equal(t, http.StatusOK, rec.Code)

		var payload systemIncidentsResponse
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &payload))
		require.Len(t, payload.Incidents, 2)

		first := payload.Incidents[0]
		assert.Equal(t, int64(2), first.ID)
		assert.Equal(t, "queue-depth", first.Policy)
		assert.Equal(t, "remediating", first.State)
		assert.True(t, opened.Equal(first.OpenedAt))
		assert.Nil(t, first.ClosedAt)
		assert.Equal(t, "workflow queue backing up", first.Summary)
		require.Len(t, first.Remediations, 2)
		assert.Equal(t, int64(10), first.Remediations[0].ID)
		assert.Equal(t, "processing", first.Remediations[0].State)
		assert.Equal(t, int32(2), first.Remediations[0].Attempts)
		require.NotNil(t, first.Remediations[0].WorkflowRunID)
		assert.Equal(t, "918273645", *first.Remediations[0].WorkflowRunID)
		assert.Nil(t, first.Remediations[1].WorkflowRunID)

		second := payload.Incidents[1]
		require.NotNil(t, second.ClosedAt)
		assert.True(t, closed.Equal(*second.ClosedAt))
		assert.Empty(t, second.Remediations)
	})

	t.Run("serializes timestamps as RFC3339 and remediations as an array", func(t *testing.T) {
		t.Parallel()

		h := &AdminSystemIncidentsHandler{
			Service: &mockAdminSystemIncidentsService{
				listIncidentsFn: func(_ context.Context, _ clusterservices.AdminSystemIncidentListInput) ([]clusterservices.AdminSystemIncident, error) {
					return []clusterservices.AdminSystemIncident{
						{ID: 1, Policy: "api-5xx", State: "open", OpenedAt: opened, Summary: "s"},
					}, nil
				},
			},
		}

		rec := doSystemIncidentsRequest(h, "/api/admin/system/incidents")
		require.Equal(t, http.StatusOK, rec.Code)

		var raw struct {
			Incidents []map[string]json.RawMessage `json:"incidents"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &raw))
		require.Len(t, raw.Incidents, 1)
		inc := raw.Incidents[0]
		for _, key := range []string{"id", "policy", "state", "opened_at", "closed_at", "summary", "remediations"} {
			assert.Contains(t, inc, key)
		}
		assert.JSONEq(t, `"2026-08-15T12:00:00Z"`, string(inc["opened_at"]))
		assert.Equal(t, "null", string(inc["closed_at"]))
		assert.Equal(t, "[]", string(inc["remediations"]))

		var openedAt time.Time
		require.NoError(t, json.Unmarshal(inc["opened_at"], &openedAt))
		assert.True(t, opened.Equal(openedAt))
	})

	t.Run("returns an empty array when there are no incidents", func(t *testing.T) {
		t.Parallel()

		h := &AdminSystemIncidentsHandler{Service: &mockAdminSystemIncidentsService{}}

		rec := doSystemIncidentsRequest(h, "/api/admin/system/incidents")
		require.Equal(t, http.StatusOK, rec.Code)

		var raw map[string]json.RawMessage
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &raw))
		assert.Equal(t, "[]", string(raw["incidents"]))
	})

	t.Run("passes validated query params through", func(t *testing.T) {
		t.Parallel()

		cases := []struct {
			name      string
			target    string
			wantState string
			wantLimit int
		}{
			{name: "defaults", target: "/api/admin/system/incidents", wantState: "active", wantLimit: 50},
			{name: "state all", target: "/api/admin/system/incidents?state=all", wantState: "all", wantLimit: 50},
			{name: "state open", target: "/api/admin/system/incidents?state=open", wantState: "open", wantLimit: 50},
			{name: "explicit limit", target: "/api/admin/system/incidents?limit=7", wantState: "active", wantLimit: 7},
			{name: "max limit", target: "/api/admin/system/incidents?state=all&limit=200", wantState: "all", wantLimit: 200},
			{name: "blank state falls back to active", target: "/api/admin/system/incidents?state=", wantState: "active", wantLimit: 50},
		}

		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				t.Parallel()

				var got clusterservices.AdminSystemIncidentListInput
				h := &AdminSystemIncidentsHandler{
					Service: &mockAdminSystemIncidentsService{
						listIncidentsFn: func(_ context.Context, input clusterservices.AdminSystemIncidentListInput) ([]clusterservices.AdminSystemIncident, error) {
							got = input
							return nil, nil
						},
					},
				}

				rec := doSystemIncidentsRequest(h, tc.target)
				require.Equal(t, http.StatusOK, rec.Code)
				assert.Equal(t, tc.wantState, got.State)
				assert.Equal(t, tc.wantLimit, got.Limit)
			})
		}
	})

	t.Run("rejects bad query params with 400", func(t *testing.T) {
		t.Parallel()

		cases := []struct {
			name   string
			target string
		}{
			{name: "unknown state", target: "/api/admin/system/incidents?state=closed"},

			{name: "non-numeric limit", target: "/api/admin/system/incidents?limit=abc"},
			{name: "zero limit", target: "/api/admin/system/incidents?limit=0"},
			{name: "negative limit", target: "/api/admin/system/incidents?limit=-5"},
			{name: "limit above max", target: "/api/admin/system/incidents?limit=201"},
		}

		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				t.Parallel()

				called := false
				h := &AdminSystemIncidentsHandler{
					Service: &mockAdminSystemIncidentsService{
						listIncidentsFn: func(_ context.Context, _ clusterservices.AdminSystemIncidentListInput) ([]clusterservices.AdminSystemIncident, error) {
							called = true
							return nil, nil
						},
					},
				}

				rec := doSystemIncidentsRequest(h, tc.target)
				assert.Equal(t, http.StatusBadRequest, rec.Code)
				assert.False(t, called, "service must not be reached for an invalid request")
			})
		}
	})

	t.Run("propagates a service bad request", func(t *testing.T) {
		t.Parallel()

		h := &AdminSystemIncidentsHandler{
			Service: &mockAdminSystemIncidentsService{
				listIncidentsFn: func(_ context.Context, _ clusterservices.AdminSystemIncidentListInput) ([]clusterservices.AdminSystemIncident, error) {
					return nil, pkgerrors.BadRequest("invalid state: must be one of open, all")
				},
			},
		}

		rec := doSystemIncidentsRequest(h, "/api/admin/system/incidents")
		assert.Equal(t, http.StatusBadRequest, rec.Code)
	})

	t.Run("returns 500 and hides detail when the store fails", func(t *testing.T) {
		t.Parallel()

		h := &AdminSystemIncidentsHandler{
			Service: &mockAdminSystemIncidentsService{
				listIncidentsFn: func(_ context.Context, _ clusterservices.AdminSystemIncidentListInput) ([]clusterservices.AdminSystemIncident, error) {
					return nil, pkgerrors.Internal("failed to list alert incidents: dial tcp 10.0.0.1:5432: refused")
				},
			},
		}

		rec := doSystemIncidentsRequest(h, "/api/admin/system/incidents")
		assert.Equal(t, http.StatusInternalServerError, rec.Code)
		assert.NotContains(t, rec.Body.String(), "5432")
	})
}

type fakeIncidentActions struct {
	called string
	id     int64
	note   *string
	until  time.Time
	bulk   clusterservices.AdminIncidentBulkInput
	actor  services.AdminAuditActor
	err    error
}

func (f *fakeIncidentActions) result(ctx context.Context, action string, id int64) (clusterservices.AdminSystemIncident, error) {
	f.called = action
	f.id = id
	f.actor, _ = services.AdminAuditActorFromContext(ctx)
	return clusterservices.AdminSystemIncident{ID: id, IncidentID: "canary-1", Source: "canary", Condition: "condition", Occurrences: 12, State: "open"}, f.err
}
func (f *fakeIncidentActions) Acknowledge(ctx context.Context, id int64, note *string) (clusterservices.AdminSystemIncident, error) {
	f.note = note
	return f.result(ctx, "acknowledge", id)
}
func (f *fakeIncidentActions) Unacknowledge(ctx context.Context, id int64) (clusterservices.AdminSystemIncident, error) {
	return f.result(ctx, "unacknowledge", id)
}
func (f *fakeIncidentActions) Resolve(ctx context.Context, id int64, note *string) (clusterservices.AdminSystemIncident, error) {
	f.note = note
	return f.result(ctx, "resolve", id)
}
func (f *fakeIncidentActions) Snooze(ctx context.Context, id int64, until time.Time) (clusterservices.AdminSystemIncident, error) {
	f.until = until
	return f.result(ctx, "snooze", id)
}
func (f *fakeIncidentActions) Bulk(ctx context.Context, in clusterservices.AdminIncidentBulkInput) (int64, error) {
	f.bulk = in
	_, err := f.result(ctx, "bulk", 0)
	return 2, err
}

func TestAdminIncidentActionHandlers(t *testing.T) {
	for _, action := range []string{"acknowledge", "unacknowledge", "resolve", "snooze", "bulk"} {
		t.Run(action, func(t *testing.T) {
			for _, bad := range []bool{false, true} {
				f := &fakeIncidentActions{}
				if bad {
					f.err = pkgerrors.Conflict("conflict")
				}
				h := &AdminSystemIncidentsHandler{Actions: f}
				r := chi.NewRouter()
				r.Post("/{id}/acknowledge", h.Acknowledge)
				r.Post("/{id}/unacknowledge", h.Unacknowledge)
				r.Post("/{id}/resolve", h.Resolve)
				r.Post("/{id}/snooze", h.Snooze)
				r.Post("/bulk", h.Bulk)
				body := `{"note":"checked"}`
				path := "/229/" + action
				if action == "snooze" {
					body = `{"until":"2026-09-15T12:00:00-07:00"}`
				}
				if action == "unacknowledge" {
					body = ""
				}
				if action == "bulk" {
					body = `{"action":"resolve","ids":[1,2],"note":"checked"}`
					path = "/bulk"
				}
				req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
				req = req.WithContext(context.WithValue(req.Context(), middleware.UserContextKey, &db.User{ID: 7, Username: "operator", IsAdmin: true}))
				rec := httptest.NewRecorder()
				r.ServeHTTP(rec, req)
				require.Equal(t, action, f.called)
				require.Equal(t, int64(7), f.actor.UserID)
				if bad {
					require.Equal(t, 409, rec.Code)
					continue
				}
				require.Equal(t, 200, rec.Code)
				if action == "bulk" {
					require.JSONEq(t, `{"affected":2}`, rec.Body.String())
					require.Equal(t, []int64{1, 2}, f.bulk.IDs)
				} else {
					var raw map[string]json.RawMessage
					require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &raw))
					require.Equal(t, `"canary-1"`, string(raw["incident_id"]))
					require.Equal(t, `12`, string(raw["occurrences"]))
					require.Equal(t, `[]`, string(raw["remediations"]))
				}
				if action == "acknowledge" || action == "resolve" {
					require.Equal(t, "checked", *f.note)
				}
				if action == "snooze" {
					require.Equal(t, "2026-09-15T19:00:00Z", f.until.UTC().Format(time.RFC3339))
				}
			}
		})
	}
}

func TestAdminIncidentActionHandlerInvalidRequests(t *testing.T) {
	for _, tc := range []struct{ action, path, body string }{
		{"acknowledge", "/bad/acknowledge", `{}`}, {"unacknowledge", "/0/unacknowledge", ``}, {"resolve", "/-1/resolve", `{}`},
		{"acknowledge", "/1/acknowledge", `{`}, {"resolve", "/1/resolve", `{`}, {"snooze", "/1/snooze", `{"until":"tomorrow"}`}, {"bulk", "/bulk", `{`},
	} {
		t.Run(tc.path+tc.body, func(t *testing.T) {
			f := &fakeIncidentActions{}
			h := &AdminSystemIncidentsHandler{Actions: f}
			r := chi.NewRouter()
			r.Post("/{id}/acknowledge", h.Acknowledge)
			r.Post("/{id}/unacknowledge", h.Unacknowledge)
			r.Post("/{id}/resolve", h.Resolve)
			r.Post("/{id}/snooze", h.Snooze)
			r.Post("/bulk", h.Bulk)
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, httptest.NewRequest("POST", tc.path, strings.NewReader(tc.body)))
			require.Equal(t, 400, rec.Code)
			require.Empty(t, f.called)
		})
	}
	h := &AdminSystemIncidentsHandler{}
	for _, handler := range []http.HandlerFunc{h.Acknowledge, h.Unacknowledge, h.Resolve, h.Snooze, h.Bulk} {
		rec := httptest.NewRecorder()
		handler(rec, httptest.NewRequest("POST", "/1", nil))
		require.Equal(t, 500, rec.Code)
	}
}

func TestAdminIncidentResponseLifecycleJSON(t *testing.T) {
	local := time.Date(2026, 9, 14, 12, 0, 0, 0, time.FixedZone("offset", 3600))
	actor := "operator"
	note := "fixed"
	data, err := json.Marshal(toSystemIncidentResponse(clusterservices.AdminSystemIncident{ID: 229, IncidentID: "canary-run", Policy: "policy", Condition: "condition", State: "open", Source: "canary", Summary: "summary", URL: "https://example.com", Runbook: "runbook", Occurrences: 12, OpenedAt: local, LastSeenAt: local, ClosedAt: &local, AcknowledgedAt: &local, AcknowledgedBy: &actor, SnoozedUntil: &local, ResolvedBy: &actor, ResolutionNote: &note}))
	require.NoError(t, err)
	require.JSONEq(t, `{"id":229,"incident_id":"canary-run","policy":"policy","condition":"condition","state":"open","source":"canary","summary":"summary","url":"https://example.com","runbook":"runbook","occurrences":12,"opened_at":"2026-09-14T11:00:00Z","last_seen_at":"2026-09-14T11:00:00Z","closed_at":"2026-09-14T11:00:00Z","acknowledged_at":"2026-09-14T11:00:00Z","acknowledged_by":"operator","snoozed_until":"2026-09-14T11:00:00Z","resolved_by":"operator","resolution_note":"fixed","remediations":[]}`, string(data))
	for _, state := range []string{"active", "open", "acknowledged", "snoozed", "resolved", "all"} {
		input, err := parseSystemIncidentsQuery(httptest.NewRequest("GET", "/?state="+state+"&policy=exact%20policy", nil))
		require.Nil(t, err)
		require.Equal(t, state, input.State)
		require.Equal(t, "exact policy", input.Policy)
	}
}
