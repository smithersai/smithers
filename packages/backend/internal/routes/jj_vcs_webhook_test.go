package routes

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/internal/webhooks"
)

type jjVCSWebhookDispatchCall struct {
	repoID    int64
	eventType webhooks.EventType
	payload   any
}

type mockJJVCSWebhookDispatcher struct {
	dispatchFn func(ctx context.Context, repoID int64, eventType webhooks.EventType, payload any) error
	calls      []jjVCSWebhookDispatchCall
}

func (m *mockJJVCSWebhookDispatcher) DispatchEvent(ctx context.Context, repoID int64, eventType webhooks.EventType, payload any) error {
	m.calls = append(m.calls, jjVCSWebhookDispatchCall{
		repoID:    repoID,
		eventType: eventType,
		payload:   payload,
	})
	if m.dispatchFn != nil {
		return m.dispatchFn(ctx, repoID, eventType, payload)
	}
	return nil
}

func (m *mockJJVCSWebhookDispatcher) DispatchOrgEvent(ctx context.Context, orgID int64, eventType webhooks.EventType, payload any) error {
	return nil
}

type mockJJVCSWebhookRepoResolver struct {
	getRepoFn func(ctx context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error)
	calls     int
}

func (m *mockJJVCSWebhookRepoResolver) GetRepoByOwnerAndName(ctx context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
	m.calls++
	if m.getRepoFn != nil {
		return m.getRepoFn(ctx, arg)
	}
	return db.GetRepoByOwnerAndNameRow{
		ID:   1,
		Name: arg.Name,
	}, nil
}

func (m *mockJJVCSWebhookRepoResolver) ListAllProtectedBookmarksByRepo(ctx context.Context, repositoryID int64) ([]db.ProtectedBookmark, error) {
	return nil, nil
}

func newJJVCSWebhookTestHandler(fakeServer *httptest.Server, resolver JJVCSRepoResolver, dispatcher webhooks.Dispatcher) *JJVCSHandler {
	return &JJVCSHandler{
		RepoHost:          repohost.NewClient(&repohost.StaticStorageSetResolver{URL: fakeServer.URL}, "test-token", nil),
		RepoResolver:      resolver,
		WebhookDispatcher: dispatcher,
	}
}

func withJJWebhookRouteParams(req *http.Request, params map[string]string) *http.Request {
	routeCtx := chi.NewRouteContext()
	for key, value := range params {
		routeCtx.URLParams.Add(key, value)
	}
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx))
}

func withJJWebhookAuth(req *http.Request, userID int64, username string) *http.Request {
	return req.WithContext(middleware.ContextWithAuthInfo(req.Context(), &middleware.AuthInfo{
		User: &db.User{ID: userID, Username: username},
	}))
}

func TestJJVCSHandler_CreateBookmark_DispatchesCreateEvent(t *testing.T) {
	t.Parallel()

	resolver := &mockJJVCSWebhookRepoResolver{
		getRepoFn: func(ctx context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
			return db.GetRepoByOwnerAndNameRow{ID: 41, Name: "DemoRepo"}, nil
		},
	}
	dispatcher := &mockJJVCSWebhookDispatcher{}

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(repohost.Bookmark{
			Name:             "release",
			TargetChangeID:   "chg-abc",
			TargetCommitID:   "sha",
			IsTrackingRemote: false,
		})
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSWebhookTestHandler(fakeServer, resolver, dispatcher)
	req := httptest.NewRequest(http.MethodPost, "/api/repos/acme/demo/bookmarks", strings.NewReader(`{"name":"release","target_change_id":"chg-abc"}`))
	req = withJJWebhookRouteParams(req, map[string]string{"owner": "acme", "repo": "demo"})
	req = withJJWebhookAuth(req, 7, "alice")
	rec := httptest.NewRecorder()

	h.CreateBookmark(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	require.Len(t, dispatcher.calls, 1)
	assert.Equal(t, webhooks.EventTypeCreate, dispatcher.calls[0].eventType)
	assert.Equal(t, int64(41), dispatcher.calls[0].repoID)
}

func TestJJVCSHandler_DeleteBookmark_DispatchesDeleteEvent(t *testing.T) {
	t.Parallel()

	resolver := &mockJJVCSWebhookRepoResolver{
		getRepoFn: func(ctx context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
			return db.GetRepoByOwnerAndNameRow{ID: 42, Name: "DemoRepo"}, nil
		},
	}
	dispatcher := &mockJJVCSWebhookDispatcher{}

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSWebhookTestHandler(fakeServer, resolver, dispatcher)
	req := httptest.NewRequest(http.MethodDelete, "/api/repos/acme/demo/bookmarks/main", nil)
	req = withJJWebhookRouteParams(req, map[string]string{"owner": "acme", "repo": "demo", "name": "main"})
	req = withJJWebhookAuth(req, 8, "bob")
	rec := httptest.NewRecorder()

	h.DeleteBookmark(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	require.Len(t, dispatcher.calls, 1)
	assert.Equal(t, webhooks.EventTypeDelete, dispatcher.calls[0].eventType)
	assert.Equal(t, int64(42), dispatcher.calls[0].repoID)
}

func TestJJVCSHandler_CreateBookmark_RepoHostError_DoesNotDispatch(t *testing.T) {
	t.Parallel()

	resolver := &mockJJVCSWebhookRepoResolver{}
	dispatcher := &mockJJVCSWebhookDispatcher{}

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"message":"bookmark already exists"}`))
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSWebhookTestHandler(fakeServer, resolver, dispatcher)
	req := httptest.NewRequest(http.MethodPost, "/api/repos/acme/demo/bookmarks", strings.NewReader(`{"name":"main","target_change_id":"chg-abc"}`))
	req = withJJWebhookRouteParams(req, map[string]string{"owner": "acme", "repo": "demo"})
	req = withJJWebhookAuth(req, 7, "alice")
	rec := httptest.NewRecorder()

	h.CreateBookmark(rec, req)

	require.Equal(t, http.StatusConflict, rec.Code)
	assert.Empty(t, dispatcher.calls)
}

func TestJJVCSHandler_DeleteBookmark_RepoHostError_DoesNotDispatch(t *testing.T) {
	t.Parallel()

	resolver := &mockJJVCSWebhookRepoResolver{}
	dispatcher := &mockJJVCSWebhookDispatcher{}

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"bookmark not found"}`))
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSWebhookTestHandler(fakeServer, resolver, dispatcher)
	req := httptest.NewRequest(http.MethodDelete, "/api/repos/acme/demo/bookmarks/main", nil)
	req = withJJWebhookRouteParams(req, map[string]string{"owner": "acme", "repo": "demo", "name": "main"})
	req = withJJWebhookAuth(req, 7, "alice")
	rec := httptest.NewRecorder()

	h.DeleteBookmark(rec, req)

	require.Equal(t, http.StatusNotFound, rec.Code)
	assert.Empty(t, dispatcher.calls)
}

func TestJJVCSHandler_CreateBookmark_RepoLookupErrors(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name       string
		resolveErr error
		status     int
		message    string
	}{
		{name: "not found", resolveErr: pgx.ErrNoRows, status: http.StatusNotFound, message: "repository not found"},
		{name: "db error", resolveErr: stdErrors.New("db down"), status: http.StatusInternalServerError, message: "internal server error"},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			repoHostCalled := false
			resolver := &mockJJVCSWebhookRepoResolver{
				getRepoFn: func(ctx context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
					return db.GetRepoByOwnerAndNameRow{}, tc.resolveErr
				},
			}
			dispatcher := &mockJJVCSWebhookDispatcher{}
			fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				repoHostCalled = true
				w.WriteHeader(http.StatusCreated)
			}))
			t.Cleanup(fakeServer.Close)

			h := newJJVCSWebhookTestHandler(fakeServer, resolver, dispatcher)
			req := httptest.NewRequest(http.MethodPost, "/api/repos/acme/demo/bookmarks", strings.NewReader(`{"name":"main","target_change_id":"chg-abc"}`))
			req = withJJWebhookRouteParams(req, map[string]string{"owner": "acme", "repo": "demo"})
			req = withJJWebhookAuth(req, 7, "alice")
			rec := httptest.NewRecorder()

			h.CreateBookmark(rec, req)

			require.Equal(t, tc.status, rec.Code)
			assert.Contains(t, rec.Body.String(), tc.message)
			assert.False(t, repoHostCalled)
			assert.Empty(t, dispatcher.calls)
		})
	}
}

func TestJJVCSHandler_DeleteBookmark_RepoLookupErrors(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name       string
		resolveErr error
		status     int
		message    string
	}{
		{name: "not found", resolveErr: pgx.ErrNoRows, status: http.StatusNotFound, message: "repository not found"},
		{name: "db error", resolveErr: stdErrors.New("db down"), status: http.StatusInternalServerError, message: "internal server error"},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			repoHostCalled := false
			resolver := &mockJJVCSWebhookRepoResolver{
				getRepoFn: func(ctx context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
					return db.GetRepoByOwnerAndNameRow{}, tc.resolveErr
				},
			}
			dispatcher := &mockJJVCSWebhookDispatcher{}
			fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				repoHostCalled = true
				w.WriteHeader(http.StatusNoContent)
			}))
			t.Cleanup(fakeServer.Close)

			h := newJJVCSWebhookTestHandler(fakeServer, resolver, dispatcher)
			req := httptest.NewRequest(http.MethodDelete, "/api/repos/acme/demo/bookmarks/main", nil)
			req = withJJWebhookRouteParams(req, map[string]string{"owner": "acme", "repo": "demo", "name": "main"})
			req = withJJWebhookAuth(req, 7, "alice")
			rec := httptest.NewRecorder()

			h.DeleteBookmark(rec, req)

			require.Equal(t, tc.status, rec.Code)
			assert.Contains(t, rec.Body.String(), tc.message)
			assert.False(t, repoHostCalled)
			assert.Empty(t, dispatcher.calls)
		})
	}
}

func TestJJVCSHandler_CreateBookmark_DispatchError_StillSucceeds(t *testing.T) {
	t.Parallel()

	resolver := &mockJJVCSWebhookRepoResolver{
		getRepoFn: func(ctx context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
			return db.GetRepoByOwnerAndNameRow{ID: 51, Name: "DemoRepo"}, nil
		},
	}
	dispatcher := &mockJJVCSWebhookDispatcher{
		dispatchFn: func(ctx context.Context, repoID int64, eventType webhooks.EventType, payload any) error {
			return stdErrors.New("enqueue failed")
		},
	}

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(repohost.Bookmark{
			Name:             "main",
			TargetChangeID:   "chg-abc",
			TargetCommitID:   "sha",
			IsTrackingRemote: false,
		})
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSWebhookTestHandler(fakeServer, resolver, dispatcher)
	req := httptest.NewRequest(http.MethodPost, "/api/repos/acme/demo/bookmarks", strings.NewReader(`{"name":"main","target_change_id":"chg-abc"}`))
	req = withJJWebhookRouteParams(req, map[string]string{"owner": "acme", "repo": "demo"})
	req = withJJWebhookAuth(req, 7, "alice")
	rec := httptest.NewRecorder()

	h.CreateBookmark(rec, req)

	// The bookmark has already been created on the repo host, so a webhook
	// enqueue failure is logged best-effort and must not fail the request —
	// a retry would replay the already-applied mutation.
	require.Equal(t, http.StatusCreated, rec.Code)
	assert.Contains(t, rec.Body.String(), `"name":"main"`)
	require.Len(t, dispatcher.calls, 1)
}

func TestJJVCSHandler_DeleteBookmark_DispatchError_StillSucceeds(t *testing.T) {
	t.Parallel()

	resolver := &mockJJVCSWebhookRepoResolver{
		getRepoFn: func(ctx context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
			return db.GetRepoByOwnerAndNameRow{ID: 52, Name: "DemoRepo"}, nil
		},
	}
	dispatcher := &mockJJVCSWebhookDispatcher{
		dispatchFn: func(ctx context.Context, repoID int64, eventType webhooks.EventType, payload any) error {
			return stdErrors.New("enqueue failed")
		},
	}

	fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(fakeServer.Close)

	h := newJJVCSWebhookTestHandler(fakeServer, resolver, dispatcher)
	req := httptest.NewRequest(http.MethodDelete, "/api/repos/acme/demo/bookmarks/main", nil)
	req = withJJWebhookRouteParams(req, map[string]string{"owner": "acme", "repo": "demo", "name": "main"})
	req = withJJWebhookAuth(req, 7, "alice")
	rec := httptest.NewRecorder()

	h.DeleteBookmark(rec, req)

	require.Equal(t, http.StatusNoContent, rec.Code)
	require.Len(t, dispatcher.calls, 1)
}

func TestJJVCSHandler_BookmarkDispatchPayload_GiteaCompatible(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name             string
		method           string
		path             string
		body             string
		routeParams      map[string]string
		expectedStatus   int
		expectedEvent    webhooks.EventType
		expectedAction   string
		repoHostResponse func(w http.ResponseWriter)
	}{
		{
			name:           "create",
			method:         http.MethodPost,
			path:           "/api/repos/acme/demo/bookmarks",
			body:           `{"name":"main","target_change_id":"chg-abc"}`,
			routeParams:    map[string]string{"owner": "acme", "repo": "demo"},
			expectedStatus: http.StatusCreated,
			expectedEvent:  webhooks.EventTypeCreate,
			expectedAction: "created",
			repoHostResponse: func(w http.ResponseWriter) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusCreated)
				_ = json.NewEncoder(w).Encode(repohost.Bookmark{
					Name:             "main",
					TargetChangeID:   "chg-abc",
					TargetCommitID:   "sha",
					IsTrackingRemote: false,
				})
			},
		},
		{
			name:           "delete",
			method:         http.MethodDelete,
			path:           "/api/repos/acme/demo/bookmarks/main",
			routeParams:    map[string]string{"owner": "acme", "repo": "demo", "name": "main"},
			expectedStatus: http.StatusNoContent,
			expectedEvent:  webhooks.EventTypeDelete,
			expectedAction: "deleted",
			repoHostResponse: func(w http.ResponseWriter) {
				w.WriteHeader(http.StatusNoContent)
			},
		},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			resolver := &mockJJVCSWebhookRepoResolver{
				getRepoFn: func(ctx context.Context, arg db.GetRepoByOwnerAndNameParams) (db.GetRepoByOwnerAndNameRow, error) {
					return db.GetRepoByOwnerAndNameRow{ID: 91, Name: "DemoRepo"}, nil
				},
			}
			dispatcher := &mockJJVCSWebhookDispatcher{}
			fakeServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				tc.repoHostResponse(w)
			}))
			t.Cleanup(fakeServer.Close)

			h := newJJVCSWebhookTestHandler(fakeServer, resolver, dispatcher)
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			req = withJJWebhookRouteParams(req, tc.routeParams)
			req = withJJWebhookAuth(req, 17, "carol")
			rec := httptest.NewRecorder()

			if tc.method == http.MethodPost {
				h.CreateBookmark(rec, req)
			} else {
				h.DeleteBookmark(rec, req)
			}

			require.Equal(t, tc.expectedStatus, rec.Code)
			require.Len(t, dispatcher.calls, 1)
			assert.Equal(t, tc.expectedEvent, dispatcher.calls[0].eventType)

			payload, ok := dispatcher.calls[0].payload.(webhooks.RepositoryEventPayload)
			require.True(t, ok)
			assert.Equal(t, tc.expectedAction, payload.Action)
			assert.Equal(t, int64(91), payload.Repository.ID)
			assert.Equal(t, "DemoRepo", payload.Repository.Name)
			assert.Equal(t, "acme/DemoRepo", payload.Repository.FullName)
			assert.Equal(t, int64(17), payload.Sender.ID)
			assert.Equal(t, "carol", payload.Sender.Login)
		})
	}
}
