package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// A head that advertises batches the journal no longer holds is corruption,
// not a page with more to come: a reader that trusted "more" would query the
// same empty range forever.
func TestMissingBatchesFailReplay(t *testing.T) {
	store := needStore(t)
	ctx := context.Background()
	for _, missing := range []string{"tail", "all"} {
		t.Run(missing, func(t *testing.T) {
			scope, runID, journal := testScope(), uuid.NewString(), testJournal()
			accepted := admit(t, store, scope, runID, journal)
			grant, err := store.Claim(ctx, scope, accepted.TurnID, time.Minute)
			if err != nil {
				t.Fatal(err)
			}
			first, err := store.Commit(ctx, CommitInput{TurnID: grant.TurnID, Generation: grant.Generation, Token: grant.Token, Expected: grant.Cursor, Frames: []json.RawMessage{frame(runID, "output")}})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = store.Cancel(ctx, scope, runID); err != nil {
				t.Fatal(err)
			}
			if _, err = store.pool.Exec(ctx, `DELETE FROM chat_turn_batches WHERE turn_id=$1 AND ($2='all' OR batch_number=2)`, accepted.TurnID, missing); err != nil {
				t.Fatal(err)
			}
			if missing == "tail" {
				page, err := store.Replay(ctx, ReplayInput{Scope: scope, RunID: runID, Journal: journal, Limit: 1})
				if err != nil || !page.More || !sameCursor(page.Next, first.Cursor) {
					t.Fatalf("intact bounded page: %#v %v", page, err)
				}
				if _, err = store.Replay(ctx, ReplayInput{Scope: scope, RunID: runID, Journal: journal, After: &first.Cursor, Limit: 1}); !errors.Is(err, ErrCorrupt) {
					t.Errorf("missing tail after boundary: %v", err)
				}
			}
			if page, err := store.Replay(ctx, ReplayInput{Scope: scope, RunID: runID, Journal: journal}); !errors.Is(err, ErrCorrupt) {
				t.Fatalf("missing %s: next=%d head=%d more=%v err=%v", missing, page.Next.Batch, page.Head.Batch, page.More, err)
			}
		})
	}
}

// acceptanceWriter runs a hook at the first flush, which is the acceptance
// delivery, before the stream reads its first page.
type acceptanceWriter struct {
	*httptest.ResponseRecorder
	onAccepted func()
}

func (w *acceptanceWriter) Flush() {
	w.ResponseRecorder.Flush()
	if w.onAccepted != nil {
		hook := w.onAccepted
		w.onAccepted = nil
		hook()
	}
}

func TestMissingTailStopsTurnStream(t *testing.T) {
	store := needStore(t)
	scope, runID, journal := testScope(), uuid.NewString(), testJournal()
	var logs bytes.Buffer
	handler := &Handler{Store: store, Dispatcher: &Dispatcher{}, logger: slog.New(slog.NewTextHandler(&logs, nil))}
	w := &acceptanceWriter{ResponseRecorder: httptest.NewRecorder()}
	w.onAccepted = func() {
		if _, err := store.Cancel(context.Background(), scope, runID); err != nil {
			t.Error(err)
		}
		if _, err := store.pool.Exec(context.Background(), `DELETE FROM chat_turn_batches WHERE turn_id IN (SELECT id FROM chat_turns WHERE user_id=$1 AND run_id=$2)`, scope.UserID, runID); err != nil {
			t.Error(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	request := httptest.NewRequest(http.MethodPost, TurnPath, bytes.NewReader(turnBody(runID, journal))).WithContext(ctx)
	authenticatedRoutes(handler, scope.UserID, scope.Owner).ServeHTTP(w, request)
	if ctx.Err() != nil {
		t.Fatal("stream looped until its context expired")
	}
	if !strings.Contains(logs.String(), "code=corrupt") || strings.Contains(w.Body.String(), "caught-up") {
		t.Fatalf("stream failed to report corruption: logs=%s body=%s", &logs, w.Body)
	}
}
