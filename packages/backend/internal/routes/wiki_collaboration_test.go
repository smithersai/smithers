package routes

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
)

type wikiRoutesFixture struct {
	sync.Mutex
	events  []services.WikiUpdateEvent
	applied int
	last    services.WikiUpdateInput
}

func (f *wikiRoutesFixture) GetWikiDocument(context.Context, *db.User, string, string, string) (services.WikiDocumentResponse, error) {
	return services.WikiDocumentResponse{State: "AAA="}, nil
}
func (f *wikiRoutesFixture) ApplyWikiUpdate(_ context.Context, _ *db.User, _, _, _ string, input services.WikiUpdateInput) (services.WikiUpdateResponse, error) {
	f.applied++
	f.last = input
	return services.WikiUpdateResponse{UpdateID: input.UpdateID, AcceptedRevision: 2}, nil
}
func (f *wikiRoutesFixture) ListWikiUpdates(_ context.Context, _ *db.User, _, _, _ string, page, after int64) ([]services.WikiUpdateEvent, error) {
	f.Lock()
	defer f.Unlock()
	out := []services.WikiUpdateEvent{}
	for _, e := range f.events {
		if e.Revision > after {
			out = append(out, e)
			if len(out) == 100 {
				break
			}
		}
	}
	return out, nil
}

type wikiRevocations struct{ events chan revocation.Event }

func (s *wikiRevocations) Watch(context.Context, revocation.Principal) <-chan revocation.Event {
	return s.events
}
func (*wikiRevocations) Subscribe(func(revocation.Event)) func() { return func() {} }

func wikiRequest(method, path, body string) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	return withAuth(withRepoCtx(withRouteParams(r, map[string]string{"owner": "alice", "repo": "demo", "slug": "home"}), 42, "alice", "demo"), 7, "alice")
}

func TestWikiCollaborationHTTPBodyAndCursor(t *testing.T) {
	f := &wikiRoutesFixture{}
	h := WikiCollaborationHandler{Service: f}
	// Base64 overhead is allowed up to the endpoint's 2MiB JSON limit.
	data, _ := json.Marshal(services.WikiUpdateInput{PageID: 42, UpdateID: "id", Update: strings.Repeat("A", (1<<20)+10)})
	rec := httptest.NewRecorder()
	h.Apply(rec, wikiRequest("POST", "/", string(data)))
	require.Equal(t, 200, rec.Code)
	require.Equal(t, 1, f.applied)
	for _, body := range []string{`{} {}`, `{"unexpected":1}`, strings.Repeat("x", 2<<20)} {
		rec = httptest.NewRecorder()
		h.Apply(rec, wikiRequest("POST", "/", body))
		require.GreaterOrEqual(t, rec.Code, 400)
	}
	require.Equal(t, 1, f.applied)
	r := wikiRequest("GET", "/?page_id=42&after=1", "")
	r.Header.Set("Last-Event-ID", "3")
	page, after, err := wikiCursor(r)
	require.NoError(t, err)
	require.Equal(t, int64(42), page)
	require.Equal(t, int64(3), after)
	for _, path := range []string{"/", "/?page_id=0", "/?page_id=42&after=-1", "/?page_id=42&after=oops"} {
		_, _, err = wikiCursor(wikiRequest("GET", path, ""))
		require.Error(t, err)
	}
}

func TestWikiCollaborationSSEReplayLiveAndRevocation(t *testing.T) {
	databaseURL := os.Getenv("SMITHERS_WIKI_STREAM_TEST_DATABASE_URL")
	if databaseURL == "" {
		if os.Getenv("SMITHERS_REQUIRE_DATABASE_TESTS") == "1" {
			t.Fatal("SMITHERS_WIKI_STREAM_TEST_DATABASE_URL is required")
		}
		t.Skip("SMITHERS_WIKI_STREAM_TEST_DATABASE_URL opts into real broker integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	config, err := pgxpool.ParseConfig(databaseURL)
	require.NoError(t, err)
	adminConfig := config.Copy()
	adminConfig.ConnConfig.Database = "postgres"
	admin, err := pgxpool.NewWithConfig(ctx, adminConfig)
	require.NoError(t, err)
	defer admin.Close()
	var exists bool
	require.NoError(t, admin.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname=$1)`, config.ConnConfig.Database).Scan(&exists))
	if !exists {
		_, err = admin.Exec(ctx, `CREATE DATABASE `+pgx.Identifier{config.ConnConfig.Database}.Sanitize())
		require.NoError(t, err)
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	require.NoError(t, err)
	defer pool.Close()
	broker := sse.NewBroker(pool)
	require.NoError(t, broker.Start(ctx))
	defer broker.Stop()
	source := &wikiRevocations{events: make(chan revocation.Event, 1)}
	SetRevocationSource(source)
	defer SetRevocationSource(nil)
	f := &wikiRoutesFixture{}
	for i := int64(1); i <= 103; i++ {
		f.events = append(f.events, services.WikiUpdateEvent{ID: i, PageID: 42, Revision: i, Slug: "home"})
	}
	h := WikiCollaborationHandler{Service: f, Broker: broker}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r = withAuth(withRepoCtx(withRouteParams(r, map[string]string{"owner": "alice", "repo": "demo", "slug": "home"}), 42, "alice", "demo"), 7, "alice")
		h.Stream(w, r)
	}))
	defer server.Close()
	request, err := http.NewRequestWithContext(ctx, "GET", server.URL+"?page_id=42&after=1", nil)
	require.NoError(t, err)
	response, err := http.DefaultClient.Do(request)
	require.NoError(t, err)
	defer response.Body.Close()
	require.Equal(t, 200, response.StatusCode)
	reader := bufio.NewReader(response.Body)
	next := func() (string, string) {
		id, kind := "", ""
		for {
			line, err := reader.ReadString('\n')
			require.NoError(t, err)
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "id:") {
				id = strings.TrimSpace(strings.TrimPrefix(line, "id:"))
			}
			if strings.HasPrefix(line, "event:") {
				kind = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
			}
			if line == "" && kind != "" {
				return id, kind
			}
		}
	}
	for i := 2; i <= 103; i++ {
		id, kind := next()
		require.Equal(t, strconv.Itoa(i), id)
		require.Equal(t, "wiki.update", kind)
	}
	// Duplicate/out-of-order notification payloads cannot regress the cursor;
	// the stream always drains its committed revision source.
	f.Lock()
	f.events = append(f.events, services.WikiUpdateEvent{ID: 104, PageID: 42, Revision: 104, Slug: "renamed"})
	f.Unlock()
	_, err = pool.Exec(ctx, `SELECT pg_notify('wiki_page_42', '{"revision":2}')`)
	require.NoError(t, err)
	id, kind := next()
	require.Equal(t, "104", id)
	require.Equal(t, "wiki.update", kind)
	source.events <- revocation.Event{Kind: revocation.KindTokenRevoked, UserID: 7, Reason: "removed"}
	_, kind = next()
	require.Equal(t, "revoked", kind)
}
