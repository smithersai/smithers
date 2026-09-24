package repohostserver

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

type pushCallbackRecorder struct {
	mu       sync.Mutex
	payloads []PushHookPayload
	status   func(PushHookPayload) int
}

func (c *pushCallbackRecorder) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var payload PushHookPayload
	_ = json.NewDecoder(r.Body).Decode(&payload)
	c.mu.Lock()
	c.payloads = append(c.payloads, payload)
	status := http.StatusNoContent
	if c.status != nil {
		status = c.status(payload)
	}
	c.mu.Unlock()
	w.WriteHeader(status)
}

func (c *pushCallbackRecorder) refs() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	refs := make([]string, 0, len(c.payloads))
	for _, payload := range c.payloads {
		refs = append(refs, payload.RefName)
	}
	return refs
}

func newOutboxTestServer(t *testing.T, callback http.Handler) (*Server, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(callback)
	t.Cleanup(srv.Close)
	metrics, err := NewMetrics()
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{
		config: Config{
			StoragePath:           t.TempDir(),
			PushHookCallbackURL:   srv.URL,
			PushHookCallbackToken: "secret",
		},
		metrics:    metrics,
		logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		httpClient: srv.Client(),
	}
	server.pushOutbox = newPushHookOutbox(server)
	return server, srv
}

func outboxFiles(t *testing.T, root string) []string {
	t.Helper()
	var files []string
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && filepath.Ext(path) == ".json" {
			files = append(files, path)
		}
		return nil
	})
	return files
}

func deliveryCount(server *Server, result string) float64 {
	return testutil.ToFloat64(server.metrics.pushHookDelivery.WithLabelValues(result))
}

// A failed callback keeps its event on disk for replay while sibling refs
// still deliver; a later replay delivers it with the same delivery id.
func TestPushOutboxRetainsFailedDeliveryAndReplaysIt(t *testing.T) {
	var failing atomic.Bool
	failing.Store(true)
	callback := &pushCallbackRecorder{status: func(p PushHookPayload) int {
		if p.RefName == "refs/heads/a" && failing.Load() {
			return http.StatusServiceUnavailable
		}
		return http.StatusNoContent
	}}
	server, _ := newOutboxTestServer(t, callback)
	outbox := server.pushOutbox

	payloads := []PushHookPayload{
		{Owner: "alice", Repo: "demo", RefName: "refs/heads/a"},
		{Owner: "alice", Repo: "demo", RefName: "refs/heads/b"},
		{Owner: "alice", Repo: "demo", RefName: "refs/heads/c"},
	}
	paths, err := outbox.persist(payloads)
	if err != nil {
		t.Fatalf("persist: %v", err)
	}
	outbox.deliverPaths(context.Background(), paths)

	if got, want := callback.refs(), []string{"refs/heads/a", "refs/heads/b", "refs/heads/c"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("a failed callback must not skip sibling refs: got %v, want %v", got, want)
	}
	remaining := outboxFiles(t, outbox.root())
	if len(remaining) != 1 || remaining[0] != paths[0] {
		t.Fatalf("outbox after first delivery = %v, want only %s", remaining, paths[0])
	}
	if deliveryCount(server, pushHookResultOK) != 2 || deliveryCount(server, pushHookResultRetry) != 1 {
		t.Fatalf("ok=%v retry=%v, want ok=2 retry=1", deliveryCount(server, pushHookResultOK), deliveryCount(server, pushHookResultRetry))
	}

	// Before the backoff elapses the replay leaves the entry alone.
	if pending := outbox.replay(context.Background()); pending != 1 || len(callback.refs()) != 3 {
		t.Fatalf("replay before backoff: pending=%d calls=%d", pending, len(callback.refs()))
	}

	failing.Store(false)
	outbox.now = func() time.Time { return time.Now().Add(time.Hour) }
	if pending := outbox.replay(context.Background()); pending != 0 {
		t.Fatalf("pending after replay = %d, want 0", pending)
	}
	refs := callback.refs()
	if len(refs) != 4 || refs[3] != "refs/heads/a" {
		t.Fatalf("replay deliveries = %v", refs)
	}
	callback.mu.Lock()
	first, replayed := callback.payloads[0], callback.payloads[3]
	callback.mu.Unlock()
	if first.DeliveryID == "" || first.DeliveryID != replayed.DeliveryID {
		t.Fatalf("replay must reuse delivery id: first=%q replayed=%q", first.DeliveryID, replayed.DeliveryID)
	}
	if got := testutil.ToFloat64(server.metrics.pushHookPending); got != 0 {
		t.Fatalf("outbox pending gauge = %v, want 0", got)
	}
}

// An entry left by a previous process is delivered on the first replay pass
// of a new server.
func TestPushOutboxReplaysEntriesFromPreviousProcess(t *testing.T) {
	callback := &pushCallbackRecorder{}
	server, _ := newOutboxTestServer(t, callback)
	payload := PushHookPayload{DeliveryID: "abc123", Owner: "alice", Repo: "demo", RefName: "refs/heads/main", CommitSHA: "c0ffee"}
	entry := pushHookOutboxEntry{Payload: payload, CreatedAt: time.Now().UTC(), NextAttemptAt: time.Now().UTC()}
	if err := writeDurableJSON(server.pushOutbox.entryPath(payload), entry); err != nil {
		t.Fatal(err)
	}

	server.startPushHookReplay(time.Hour)
	deadline := time.Now().Add(5 * time.Second)
	for len(callback.refs()) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if err := server.Shutdown(context.Background()); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	callback.mu.Lock()
	defer callback.mu.Unlock()
	if len(callback.payloads) != 1 || callback.payloads[0] != payload {
		t.Fatalf("replayed payloads = %#v, want %#v", callback.payloads, payload)
	}
	if files := outboxFiles(t, server.pushOutbox.root()); len(files) != 0 {
		t.Fatalf("delivered entry still on disk: %v", files)
	}
}

// An event the API keeps refusing past the maximum age moves to the dead
// directory and is counted as expired.
func TestPushOutboxExpiresOldUndeliveredEntries(t *testing.T) {
	callback := &pushCallbackRecorder{status: func(PushHookPayload) int { return http.StatusBadGateway }}
	server, _ := newOutboxTestServer(t, callback)
	payload := PushHookPayload{DeliveryID: "old", Owner: "alice", Repo: "demo", RefName: "refs/heads/main"}
	created := time.Now().UTC().Add(-25 * time.Hour)
	path := server.pushOutbox.entryPath(payload)
	if err := writeDurableJSON(path, pushHookOutboxEntry{Payload: payload, CreatedAt: created, NextAttemptAt: created}); err != nil {
		t.Fatal(err)
	}

	if pending := server.pushOutbox.replay(context.Background()); pending != 0 {
		t.Fatalf("pending = %d, want 0", pending)
	}
	if _, err := os.Stat(filepath.Join(server.pushOutbox.dead(), "alice", "demo", "old.json")); err != nil {
		t.Fatalf("expired entry not in dead directory: %v", err)
	}
	if got := deliveryCount(server, pushHookResultExpired); got != 1 {
		t.Fatalf("expired = %v, want 1", got)
	}
}

// The API's typed not_found means the repository is gone: the event is
// dropped. An unrouted 404 is a failed delivery and stays for retry.
func TestPushOutboxNotFoundHandling(t *testing.T) {
	typed := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"code":"not_found"}`))
	})
	server, _ := newOutboxTestServer(t, typed)
	paths, err := server.pushOutbox.persist([]PushHookPayload{{Owner: "alice", Repo: "gone", RefName: "refs/heads/main"}})
	if err != nil {
		t.Fatal(err)
	}
	server.pushOutbox.deliverPaths(context.Background(), paths)
	if files := outboxFiles(t, server.pushOutbox.root()); len(files) != 0 {
		t.Fatalf("typed not_found must drop the event: %v", files)
	}
	if got := deliveryCount(server, pushHookResultNotFound); got != 1 {
		t.Fatalf("not_found = %v, want 1", got)
	}

	server, _ = newOutboxTestServer(t, http.NotFoundHandler())
	paths, err = server.pushOutbox.persist([]PushHookPayload{{Owner: "alice", Repo: "demo", RefName: "refs/heads/main"}})
	if err != nil {
		t.Fatal(err)
	}
	server.pushOutbox.deliverPaths(context.Background(), paths)
	if files := outboxFiles(t, server.pushOutbox.root()); len(files) != 1 {
		t.Fatalf("unrouted 404 must keep the event for retry: %v", files)
	}
}

func TestPushOutboxPersistAssignsDistinctDeliveryIDs(t *testing.T) {
	server, _ := newOutboxTestServer(t, &pushCallbackRecorder{})
	payloads := []PushHookPayload{
		{Owner: "alice", Repo: "demo", RefName: "refs/heads/main", CommitSHA: "a"},
		{Owner: "alice", Repo: "demo", RefName: "refs/heads/main", CommitSHA: "a"},
	}
	if _, err := server.pushOutbox.persist(payloads); err != nil {
		t.Fatal(err)
	}
	if payloads[0].DeliveryID == "" || payloads[0].DeliveryID == payloads[1].DeliveryID {
		t.Fatalf("two push events must get distinct delivery ids: %q %q", payloads[0].DeliveryID, payloads[1].DeliveryID)
	}
}

func TestPushHookRetryBackoffIsBounded(t *testing.T) {
	cases := map[int]time.Duration{0: 5 * time.Second, 1: 5 * time.Second, 2: 10 * time.Second, 8: pushHookRetryMaxBackoff, 40: pushHookRetryMaxBackoff}
	for attempts, want := range cases {
		if got := pushHookRetryBackoff(attempts); got != want {
			t.Errorf("backoff(%d) = %v, want %v", attempts, got, want)
		}
	}
}
