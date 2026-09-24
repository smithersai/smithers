package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

// streamingHost commits one delta per tick for longer than the claim lease,
// then finishes. It models a healthy long turn with tool loops.
type streamingHost struct {
	store *Store
	ticks int
	every time.Duration
}

func (h streamingHost) RunTurn(ctx context.Context, grant ProducerGrant) error {
	if err := h.store.MarkProviderStarted(ctx, grant); err != nil {
		return err
	}
	cursor := grant.Cursor
	for index := range h.ticks {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(h.every):
		}
		result, err := h.store.Commit(ctx, CommitInput{TurnID: grant.TurnID, Generation: grant.Generation, Token: grant.Token,
			Expected: cursor, Frames: []json.RawMessage{frame(grant.RunID, strings.Repeat("x", index%3+1))}})
		if err != nil {
			return err
		}
		cursor = result.Cursor
	}
	_, err := h.store.Commit(ctx, CommitInput{TurnID: grant.TurnID, Generation: grant.Generation, Token: grant.Token,
		Expected: cursor, Frames: []json.RawMessage{done(grant.RunID, "stop")}})
	return err
}

func runDispatcherUntilTerminal(t *testing.T, store *Store, dispatcher *Dispatcher, scope Scope, turnID string) State {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan error, 1)
	go func() { finished <- dispatcher.Run(ctx, 1) }()
	defer func() {
		cancel()
		<-finished
	}()
	if !dispatcher.Enqueue(Candidate{Scope: scope, TurnID: turnID}) {
		t.Fatal("enqueue refused")
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		state, terminal, err := store.GetState(context.Background(), scope, turnID)
		if err != nil {
			t.Fatal(err)
		}
		if terminal {
			return state
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("turn did not reach a terminal state")
	return ""
}

func TestDispatcherRenewsLeaseWhileHealthyHostOutlivesIt(t *testing.T) {
	store := needStore(t)
	scope, runID, journal := testScope(), "long-"+uuid.NewString(), testJournal()
	accepted := admit(t, store, scope, runID, journal)
	// The host keeps committing for about four lease lengths.
	dispatcher, err := NewDispatcher(store, streamingHost{store: store, ticks: 16, every: 50 * time.Millisecond}, 1, 200*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if state := runDispatcherUntilTerminal(t, store, dispatcher, scope, accepted.TurnID); state != StateCompleted {
		t.Fatalf("long healthy turn ended %s, want completed", state)
	}
	page, err := store.Replay(context.Background(), ReplayInput{Scope: scope, RunID: runID, Journal: journal, Limit: 16})
	if err != nil || len(page.Batches) != 16 || !page.More {
		t.Fatalf("long turn journal: batches=%d more=%v err=%v", len(page.Batches), page.More, err)
	}
}

type failingHost struct{ err error }

func (h failingHost) RunTurn(context.Context, ProducerGrant) error { return h.err }

func TestDispatcherRecordsHostFailureCause(t *testing.T) {
	store := needStore(t)
	scope, runID, journal := testScope(), "fail-"+uuid.NewString(), testJournal()
	accepted := admit(t, store, scope, runID, journal)
	dispatcher, err := NewDispatcher(store, failingHost{err: errors.New("launch owner model host: sandbox quota")}, 1, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	dispatcher.logger = slog.New(slog.NewJSONHandler(&logs, nil))
	if state := runDispatcherUntilTerminal(t, store, dispatcher, scope, accepted.TurnID); state != StateFailed {
		t.Fatalf("failed host ended %s", state)
	}
	var record map[string]any
	for line := range strings.Lines(logs.String()) {
		var candidate map[string]any
		if json.Unmarshal([]byte(line), &candidate) == nil && candidate["turn_id"] == accepted.TurnID && candidate["code"] == "host_failed" {
			record = candidate
		}
	}
	if record == nil || !strings.Contains(record["error"].(string), "sandbox quota") || record["generation"] != float64(1) {
		t.Fatalf("host failure was not logged with its cause: %s", logs.String())
	}
	if got := testutil.ToFloat64(dispatcher.metrics.failures.WithLabelValues("host_failed")); got != 1 {
		t.Fatalf("host_failed counter = %v", got)
	}
	if got := testutil.ToFloat64(dispatcher.metrics.claims); got != 1 {
		t.Fatalf("claims counter = %v", got)
	}
}

func TestCommitWakesTurnWatchers(t *testing.T) {
	store := needStore(t)
	scope, runID, journal := testScope(), "wake-"+uuid.NewString(), testJournal()
	accepted := admit(t, store, scope, runID, journal)
	grant, err := store.Claim(context.Background(), scope, accepted.TurnID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	changed, stop := store.watch(accepted.TurnID)
	defer stop()
	if _, err = store.Commit(context.Background(), CommitInput{TurnID: accepted.TurnID, Generation: grant.Generation, Token: grant.Token,
		Expected: grant.Cursor, Frames: []json.RawMessage{frame(runID, "wake")}}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-changed:
	case <-time.After(time.Second):
		t.Fatal("commit did not wake its watcher")
	}
	changed, stop2 := store.watch(accepted.TurnID)
	defer stop2()
	if _, err = store.Cancel(context.Background(), scope, runID); err != nil {
		t.Fatal(err)
	}
	select {
	case <-changed:
	case <-time.After(time.Second):
		t.Fatal("terminal append did not wake its watcher")
	}
}

func TestCommitOnOneReplicaWakesAStreamOnAnother(t *testing.T) {
	shared := needStore(t)
	writer := &Store{pool: shared.pool, now: time.Now}
	reader := &Store{pool: shared.pool, now: time.Now}
	scope, runID, journal := testScope(), "replica-"+uuid.NewString(), testJournal()
	accepted := admit(t, writer, scope, runID, journal)
	grant, err := writer.Claim(context.Background(), scope, accepted.TurnID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	listening := make(chan error, 1)
	go func() { listening <- reader.Listen(ctx, nil) }()
	defer func() {
		cancel()
		<-listening
	}()
	changed, stop := reader.watch(accepted.TurnID)
	defer stop()
	// LISTEN takes effect asynchronously; commit until the other replica hears.
	cursor := grant.Cursor
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		result, commitErr := writer.Commit(context.Background(), CommitInput{TurnID: accepted.TurnID, Generation: grant.Generation, Token: grant.Token,
			Expected: cursor, Frames: []json.RawMessage{frame(runID, "replica")}})
		if commitErr != nil {
			t.Fatal(commitErr)
		}
		cursor = result.Cursor
		select {
		case <-changed:
			return
		case <-time.After(100 * time.Millisecond):
		}
	}
	t.Fatal("a commit on one replica never woke the other replica's stream")
}
