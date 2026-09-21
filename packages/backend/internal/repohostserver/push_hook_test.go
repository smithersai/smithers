package repohostserver

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"
)

func TestPushHookSenderFromHeaders(t *testing.T) {
	headers := http.Header{}
	headers.Set("X-Smithers-Pusher-Id", "42")
	headers.Set("X-Smithers-Pusher-Login", "alice")

	sender := pushHookSenderFromHeaders(headers)
	if sender.PusherID != 42 || sender.PusherLogin != "alice" {
		t.Fatalf("unexpected sender: %#v", sender)
	}
}

func TestPushHookPayloadsFromRefDiff(t *testing.T) {
	beforeRefs := map[string]string{
		"refs/heads/main":  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"refs/tags/v1.0":   "dddddddddddddddddddddddddddddddddddddddd",
		"refs/jj/keep/old": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
	}
	afterRefs := map[string]string{
		"refs/heads/dev":   "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		"refs/heads/main":  "cccccccccccccccccccccccccccccccccccccccc",
		"refs/jj/keep/new": "ffffffffffffffffffffffffffffffffffffffff",
	}

	payloads := pushHookPayloadsFromRefDiff(beforeRefs, afterRefs, "alice", "demo", PushHookSender{
		PusherID:    42,
		PusherLogin: "alice",
	})

	want := []PushHookPayload{
		{
			Owner:       "alice",
			Repo:        "demo",
			RefName:     "refs/heads/dev",
			CommitSHA:   "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			PusherID:    42,
			PusherLogin: "alice",
		},
		{
			Owner:       "alice",
			Repo:        "demo",
			RefName:     "refs/heads/main",
			CommitSHA:   "cccccccccccccccccccccccccccccccccccccccc",
			PusherID:    42,
			PusherLogin: "alice",
		},
		{
			Owner:       "alice",
			Repo:        "demo",
			RefName:     "refs/tags/v1.0",
			CommitSHA:   "",
			PusherID:    42,
			PusherLogin: "alice",
		},
	}
	if !reflect.DeepEqual(payloads, want) {
		t.Fatalf("unexpected payloads (internal refs must be filtered): %#v", payloads)
	}
}

func TestSendPushHookPostsJSONAndBearerToken(t *testing.T) {
	var gotAuth string
	var gotPayload PushHookPayload

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&gotPayload); err != nil {
			t.Fatalf("decode push hook request: %v", err)
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	cfg := Config{
		PushHookCallbackURL:   srv.URL,
		PushHookCallbackToken: "secret",
	}
	want := PushHookPayload{Owner: "alice", Repo: "demo", RefName: "refs/heads/main", CommitSHA: "deadbeef", PusherID: 42, PusherLogin: "alice"}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := sendPushHook(ctx, srv.Client(), cfg, want); err != nil {
		t.Fatalf("sendPushHook: %v", err)
	}

	if gotAuth != "Bearer secret" {
		t.Fatalf("unexpected auth header %q", gotAuth)
	}
	if gotPayload != want {
		t.Fatalf("unexpected payload %#v", gotPayload)
	}
}

func TestDeliverPushHooksContinuesAfterCallbackFailure(t *testing.T) {
	var gotRefs []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload PushHookPayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode push hook request: %v", err)
		}
		gotRefs = append(gotRefs, payload.RefName)
		if payload.RefName == "refs/heads/a" {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	cfg := Config{PushHookCallbackURL: srv.URL, PushHookCallbackToken: "secret"}
	payloads := []PushHookPayload{
		{RefName: "refs/heads/a"},
		{RefName: "refs/heads/b"},
		{RefName: "refs/heads/c"},
	}

	deliverPushHooks(srv.Client(), cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), payloads)

	want := []string{"refs/heads/a", "refs/heads/b", "refs/heads/c"}
	if !reflect.DeepEqual(gotRefs, want) {
		t.Fatalf("a failed callback must not skip sibling refs: got %v, want %v", gotRefs, want)
	}
}

func TestSendPushHookTreatsNotFoundAsNonFatal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := sendPushHook(ctx, srv.Client(), Config{PushHookCallbackURL: srv.URL, PushHookCallbackToken: "callback-token"}, PushHookPayload{}); err != nil {
		t.Fatalf("expected 404 callback to be ignored, got %v", err)
	}
}
