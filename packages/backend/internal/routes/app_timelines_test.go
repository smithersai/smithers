package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

const testTimelineUUID = "5f0c2a3e-9d61-4a7b-8f28-3f4a1c9be0d7"

// fakeAppTimelines records the last call so tests can assert the real
// signed-in user reaches the service, and returns a canned error to drive
// every status-mapping branch over HTTP.
type fakeAppTimelines struct {
	err        error
	resolution services.AppTimelineResolution

	lastActor   int64
	lastID      string
	lastKey     string
	lastEvents  []services.AppTimelineEventWrite
	lastDump    services.AppTimelineDump
	lastSeq     int64
	lastUser    string
	lastRole    string
	lastMember  int64
	memberCalls int
}

func (f *fakeAppTimelines) FindOrCreate(_ context.Context, actor int64, clientKey string) (services.AppTimelineResolution, error) {
	f.lastActor, f.lastKey = actor, clientKey
	return f.resolution, f.err
}

func (f *fakeAppTimelines) Get(_ context.Context, actor int64, id string) (services.AppTimelineResolution, error) {
	f.lastActor, f.lastID = actor, id
	return f.resolution, f.err
}

func (f *fakeAppTimelines) AppendEvents(_ context.Context, actor int64, id string, events []services.AppTimelineEventWrite) error {
	f.lastActor, f.lastID, f.lastEvents = actor, id, events
	return f.err
}

func (f *fakeAppTimelines) Rewrite(_ context.Context, actor int64, id string, dump services.AppTimelineDump) error {
	f.lastActor, f.lastID, f.lastDump = actor, id, dump
	return f.err
}

func (f *fakeAppTimelines) PutSnapshot(_ context.Context, actor int64, id string, seq int64, _ json.RawMessage) error {
	f.lastActor, f.lastID, f.lastSeq = actor, id, seq
	return f.err
}

func (f *fakeAppTimelines) Members(_ context.Context, actor int64, id string) ([]db.ListLiveAppTimelineMemberProfilesRow, error) {
	f.lastActor, f.lastID = actor, id
	if f.err != nil {
		return nil, f.err
	}
	return []db.ListLiveAppTimelineMemberProfilesRow{
		{TimelineID: id, UserID: 1, Role: "owner", Username: "alice"},
	}, nil
}

func (f *fakeAppTimelines) AddMember(_ context.Context, actor int64, id, username, role string) (db.AppTimelineMember, error) {
	f.lastActor, f.lastID, f.lastUser, f.lastRole = actor, id, username, role
	f.memberCalls++
	if f.err != nil {
		return db.AppTimelineMember{}, f.err
	}
	return db.AppTimelineMember{TimelineID: id, UserID: 2, Role: role}, nil
}

func (f *fakeAppTimelines) RemoveMember(_ context.Context, actor int64, id string, memberUserID int64) error {
	f.lastActor, f.lastID, f.lastMember = actor, id, memberUserID
	return f.err
}

// serveAppTimeline routes req through a fully-mounted AppTimelineHandler,
// injecting a session-authenticated user (IsTokenAuth=false so RequireScope
// bypasses token-scope checks, exactly like cookie auth in prod).
func serveAppTimeline(h *AppTimelineHandler, req *http.Request, userID int64, authed bool) *httptest.ResponseRecorder {
	router := chi.NewRouter()
	if authed {
		router.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				ctx := middleware.ContextWithAuthInfo(r.Context(), &middleware.AuthInfo{
					User:        &db.User{ID: userID, Username: "member"},
					IsTokenAuth: false,
				})
				next.ServeHTTP(w, r.WithContext(ctx))
			})
		})
	}
	h.Mount(router)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func TestAppTimeline_FindOrCreate_CreatedIs201(t *testing.T) {
	fake := &fakeAppTimelines{resolution: services.AppTimelineResolution{
		Timeline: db.AppTimeline{ID: testTimelineUUID, OwnerUserID: 42, ClientKey: "default", Version: 1},
		Role:     "owner",
		Created:  true,
	}}
	h := NewAppTimelineHandler(fake)

	req := httptest.NewRequest(http.MethodPost, "/api/app-timelines", strings.NewReader(`{"client_key":"default"}`))
	rec := serveAppTimeline(h, req, 42, true)

	if rec.Code != http.StatusCreated {
		t.Fatalf("create: got %d want 201 (%s)", rec.Code, rec.Body.String())
	}
	if fake.lastActor != 42 || fake.lastKey != "default" {
		t.Fatalf("params not forwarded: actor=%d key=%q", fake.lastActor, fake.lastKey)
	}
	var body struct {
		ID      string `json:"id"`
		Role    string `json:"role"`
		HeadSeq int64  `json:"head_seq"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.ID != testTimelineUUID || body.Role != "owner" {
		t.Fatalf("wire shape wrong: %s", rec.Body.String())
	}
}

func TestAppTimeline_FindOrCreate_FoundIs200_EmptyBodyOK(t *testing.T) {
	fake := &fakeAppTimelines{resolution: services.AppTimelineResolution{
		Timeline: db.AppTimeline{ID: testTimelineUUID, OwnerUserID: 42},
		Role:     "owner",
	}}
	h := NewAppTimelineHandler(fake)

	req := httptest.NewRequest(http.MethodPost, "/api/app-timelines", nil)
	rec := serveAppTimeline(h, req, 42, true)

	if rec.Code != http.StatusOK {
		t.Fatalf("found: got %d want 200 (%s)", rec.Code, rec.Body.String())
	}
}

func TestAppTimeline_Unauthenticated401(t *testing.T) {
	h := NewAppTimelineHandler(&fakeAppTimelines{})
	req := httptest.NewRequest(http.MethodGet, "/api/app-timelines/"+testTimelineUUID, nil)
	rec := serveAppTimeline(h, req, 0, false)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("got %d want 401 (%s)", rec.Code, rec.Body.String())
	}
}

func TestAppTimeline_NonUUIDIDRejected(t *testing.T) {
	h := NewAppTimelineHandler(&fakeAppTimelines{})
	req := httptest.NewRequest(http.MethodGet, "/api/app-timelines/not-a-uuid", nil)
	rec := serveAppTimeline(h, req, 42, true)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d want 400 (%s)", rec.Code, rec.Body.String())
	}
}

func TestAppTimeline_AppendEvents_ForwardsBatchAnd204(t *testing.T) {
	fake := &fakeAppTimelines{}
	h := NewAppTimelineHandler(fake)

	req := httptest.NewRequest(http.MethodPost, "/api/app-timelines/"+testTimelineUUID+"/events",
		strings.NewReader(`{"events":[{"seq":3,"payload":{"type":"chat.user","text":"hi"}},{"seq":4,"payload":{"type":"chat.agent","text":"yo"}}]}`))
	rec := serveAppTimeline(h, req, 42, true)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("append: got %d want 204 (%s)", rec.Code, rec.Body.String())
	}
	if fake.lastActor != 42 || fake.lastID != testTimelineUUID {
		t.Fatalf("params not forwarded: actor=%d id=%q", fake.lastActor, fake.lastID)
	}
	if len(fake.lastEvents) != 2 || fake.lastEvents[0].Seq != 3 || fake.lastEvents[1].Seq != 4 {
		t.Fatalf("events not forwarded: %+v", fake.lastEvents)
	}
}

func TestAppTimeline_AppendEvents_ConflictMapsTo409(t *testing.T) {
	fake := &fakeAppTimelines{err: pkgerrors.Conflict("event seq is ahead of the timeline head; resync and retry")}
	h := NewAppTimelineHandler(fake)

	req := httptest.NewRequest(http.MethodPost, "/api/app-timelines/"+testTimelineUUID+"/events",
		strings.NewReader(`{"events":[{"seq":9,"payload":{}}]}`))
	rec := serveAppTimeline(h, req, 42, true)

	if rec.Code != http.StatusConflict {
		t.Fatalf("got %d want 409 (%s)", rec.Code, rec.Body.String())
	}
}

func TestAppTimeline_Rewrite_ForwardsDumpAnd204(t *testing.T) {
	fake := &fakeAppTimelines{}
	h := NewAppTimelineHandler(fake)

	req := httptest.NewRequest(http.MethodPut, "/api/app-timelines/"+testTimelineUUID+"/state",
		strings.NewReader(`{"version":1,"events":[{"type":"a"},{"type":"b"}],"branches":[{"from_seq":1,"events":[{"type":"c"}]}]}`))
	rec := serveAppTimeline(h, req, 42, true)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("rewrite: got %d want 204 (%s)", rec.Code, rec.Body.String())
	}
	if fake.lastDump.Version != 1 || len(fake.lastDump.Events) != 2 || len(fake.lastDump.Branches) != 1 {
		t.Fatalf("dump not forwarded: %+v", fake.lastDump)
	}
	if fake.lastDump.Branches[0].FromSeq != 1 || len(fake.lastDump.Branches[0].Events) != 1 {
		t.Fatalf("branch not forwarded: %+v", fake.lastDump.Branches[0])
	}
}

func TestAppTimeline_PutSnapshot204(t *testing.T) {
	fake := &fakeAppTimelines{}
	h := NewAppTimelineHandler(fake)

	req := httptest.NewRequest(http.MethodPut, "/api/app-timelines/"+testTimelineUUID+"/snapshots",
		strings.NewReader(`{"seq":12,"state":{"value":"chat"}}`))
	rec := serveAppTimeline(h, req, 42, true)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("snapshot: got %d want 204 (%s)", rec.Code, rec.Body.String())
	}
	if fake.lastSeq != 12 {
		t.Fatalf("seq not forwarded: %d", fake.lastSeq)
	}
}

func TestAppTimeline_ViewerWriteForbidden(t *testing.T) {
	fake := &fakeAppTimelines{err: pkgerrors.Forbidden("timeline is read-only for viewers")}
	h := NewAppTimelineHandler(fake)

	req := httptest.NewRequest(http.MethodPost, "/api/app-timelines/"+testTimelineUUID+"/events",
		strings.NewReader(`{"events":[{"seq":0,"payload":{}}]}`))
	rec := serveAppTimeline(h, req, 7, true)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("got %d want 403 (%s)", rec.Code, rec.Body.String())
	}
}

func TestAppTimeline_MembersRoundTrip(t *testing.T) {
	fake := &fakeAppTimelines{}
	h := NewAppTimelineHandler(fake)

	list := httptest.NewRequest(http.MethodGet, "/api/app-timelines/"+testTimelineUUID+"/members", nil)
	rec := serveAppTimeline(h, list, 42, true)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"alice"`) {
		t.Fatalf("list members: got %d (%s)", rec.Code, rec.Body.String())
	}

	add := httptest.NewRequest(http.MethodPost, "/api/app-timelines/"+testTimelineUUID+"/members",
		strings.NewReader(`{"username":"bob","role":"editor"}`))
	rec = serveAppTimeline(h, add, 42, true)
	if rec.Code != http.StatusCreated {
		t.Fatalf("add member: got %d want 201 (%s)", rec.Code, rec.Body.String())
	}
	if fake.lastUser != "bob" || fake.lastRole != "editor" {
		t.Fatalf("member params not forwarded: user=%q role=%q", fake.lastUser, fake.lastRole)
	}

	remove := httptest.NewRequest(http.MethodDelete, "/api/app-timelines/"+testTimelineUUID+"/members/2", nil)
	rec = serveAppTimeline(h, remove, 42, true)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("remove member: got %d want 204 (%s)", rec.Code, rec.Body.String())
	}
	if fake.lastMember != 2 {
		t.Fatalf("member id not forwarded: %d", fake.lastMember)
	}
}

func TestAppTimeline_RemoveMemberInvalidUserID400(t *testing.T) {
	h := NewAppTimelineHandler(&fakeAppTimelines{})
	req := httptest.NewRequest(http.MethodDelete, "/api/app-timelines/"+testTimelineUUID+"/members/zero", nil)
	rec := serveAppTimeline(h, req, 42, true)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d want 400 (%s)", rec.Code, rec.Body.String())
	}
}

func TestAppTimeline_InvalidBody400(t *testing.T) {
	h := NewAppTimelineHandler(&fakeAppTimelines{})
	req := httptest.NewRequest(http.MethodPost, "/api/app-timelines/"+testTimelineUUID+"/events",
		strings.NewReader(`{"events": nope`))
	rec := serveAppTimeline(h, req, 42, true)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d want 400 (%s)", rec.Code, rec.Body.String())
	}
}
