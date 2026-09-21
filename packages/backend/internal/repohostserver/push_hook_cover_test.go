package repohostserver

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type pushHookCovRoundTripper struct {
	err error
}

func (rt pushHookCovRoundTripper) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, rt.err
}

func TestPushHook_Cov_SendPushHookNoCallbackIsNoop(t *testing.T) {
	err := sendPushHook(context.Background(), http.DefaultClient, Config{}, PushHookPayload{Owner: "alice"})
	if err != nil {
		t.Fatalf("sendPushHook returned error: %v", err)
	}
}

func TestPushHook_Cov_SendPushHookRejectsInvalidURL(t *testing.T) {
	err := sendPushHook(context.Background(), http.DefaultClient, Config{PushHookCallbackURL: "http://[::1", PushHookCallbackToken: "callback-token"}, PushHookPayload{})
	if err == nil {
		t.Fatal("expected invalid callback URL error")
	}
	if !strings.Contains(err.Error(), "create push hook request") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestPushHook_Cov_SendPushHookReportsClientError(t *testing.T) {
	clientErr := errors.New("network down")
	client := &http.Client{Transport: pushHookCovRoundTripper{err: clientErr}}

	err := sendPushHook(context.Background(), client, Config{PushHookCallbackURL: "https://example.test/hook", PushHookCallbackToken: "callback-token"}, PushHookPayload{})
	if err == nil {
		t.Fatal("expected client error")
	}
	if !strings.Contains(err.Error(), "send push hook callback request") || !strings.Contains(err.Error(), "network down") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestPushHook_Cov_SendPushHookReportsNonSuccessStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	err := sendPushHook(context.Background(), srv.Client(), Config{PushHookCallbackURL: srv.URL, PushHookCallbackToken: "callback-token"}, PushHookPayload{})
	if err == nil {
		t.Fatal("expected status error")
	}
	if !strings.Contains(err.Error(), "push hook callback returned status 500") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestPushHook_Cov_SendPushHookRejectsMissingCallbackToken(t *testing.T) {
	err := sendPushHook(context.Background(), http.DefaultClient, Config{PushHookCallbackURL: "https://example.test/hook"}, PushHookPayload{})
	if err == nil || !strings.Contains(err.Error(), "callback token is not configured") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestPushHook_Cov_PayloadsSkipUnchangedRefs(t *testing.T) {
	payloads := pushHookPayloadsFromRefDiff(
		map[string]string{"refs/heads/main": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
		map[string]string{"refs/heads/main": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
		"alice",
		"demo",
		PushHookSender{PusherID: 7, PusherLogin: "alice"},
	)
	if len(payloads) != 0 {
		t.Fatalf("expected unchanged refs to be skipped, got %#v", payloads)
	}
}
