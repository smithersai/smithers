package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/ports"
)

// The producer commits one frame per batch. The byte budget must therefore
// bind before the batch count, whatever the frames are.
func TestOutputByteBudgetBindsBeforeBatchCount(t *testing.T) {
	runID := "r"
	cursor := Cursor{Version: 1, RunID: runID, LegID: "l", Batch: maxBatches - 1, Position: maxBatches - 1, Hash: strings.Repeat("0", 64)}
	candidates := []string{
		`{"runId":"r","type":"delta","kind":"text","text":""}`,
		`{"runId":"r","type":"delta","kind":"reasoning","text":""}`,
		`{"runId":"r","type":"card","card":{}}`,
		`{"runId":"r","type":"tool_call","call_id":"","name":"","arguments":""}`,
		`{"runId":"r","type":"steering.drained","link":0,"count":1}`,
	}
	smallest := 0
	for _, raw := range candidates {
		frames := []json.RawMessage{json.RawMessage(raw)}
		if _, err := validateFrames(frames, runID); err != nil {
			t.Fatalf("candidate %s is not a valid frame: %v", raw, err)
		}
		// Small batch numbers are the cheapest to encode.
		for _, at := range []int64{0, maxBatches - 1} {
			cursor.Batch, cursor.Position = at, at
			_, size, err := makeBatch(cursor, frames)
			if err != nil {
				t.Fatal(err)
			}
			if smallest == 0 || size < smallest {
				smallest = size
			}
		}
	}
	if int64(smallest)*maxBatches < maxOutputBytes {
		t.Fatalf("%d batches of %d bytes stop before the %d byte budget", maxBatches, smallest, maxOutputBytes)
	}
}

func TestHTTPChatHostReportsRefusalBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("authorization") != "Bearer host-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"code":"provider_unreachable"}` + strings.Repeat("x", 8192)))
	}))
	defer server.Close()
	host, err := NewHTTPChatHost(server.URL, nil, "host-token")
	if err != nil {
		t.Fatal(err)
	}
	if host.client.Timeout != 0 {
		t.Fatalf("turn client carries a fixed %s timeout; the dispatcher context bounds a turn", host.client.Timeout)
	}
	err = host.RunChatTurn(context.Background(), ports.ChatTurnGrant{TurnID: "turn"})
	if err == nil || !strings.Contains(err.Error(), "502") || !strings.Contains(err.Error(), "provider_unreachable") {
		t.Fatalf("refusal error = %v", err)
	}
	if len(err.Error()) > 1024 {
		t.Fatalf("refusal error is unbounded: %d bytes", len(err.Error()))
	}
}

func TestHTTPChatHostKeepsBaseURLPathPrefix(t *testing.T) {
	for base, want := range map[string]string{
		"http://host.internal":         ModelHostTurnPath,
		"http://host.internal/":        ModelHostTurnPath,
		"http://host.internal/model":   "/model" + ModelHostTurnPath,
		"http://host.internal/model/":  "/model" + ModelHostTurnPath,
		"https://host.internal/a/b%2F": "/a/b%2F" + ModelHostTurnPath,
	} {
		host, err := NewHTTPChatHost(base, nil, "host-token")
		if err != nil {
			t.Fatalf("%s: %v", base, err)
		}
		if got := host.endpoint.EscapedPath(); got != want {
			t.Fatalf("%s posts to %s, want %s", base, got, want)
		}
	}
}

// Every store sentinel a producer callback can see must keep its meaning on
// the wire. Only an unclassified storage error is a 503.
func TestProducerErrorMapsEverySentinel(t *testing.T) {
	cases := map[error]struct {
		status int
		code   string
	}{
		ErrProducerFenced: {http.StatusUnauthorized, "producer_fenced"},
		ErrNotFound:       {http.StatusUnauthorized, "producer_fenced"},
		ErrForbidden:      {http.StatusUnauthorized, "producer_fenced"},
		ErrInvalidRequest: {http.StatusBadRequest, "frame_invalid"},
		ErrInvalidFrame:   {http.StatusBadRequest, "frame_invalid"},
		ErrLimit:          {http.StatusConflict, "limit"},
		ErrConflict:       {http.StatusConflict, "producer_conflict"},
		ErrCursorConflict: {http.StatusConflict, "producer_conflict"},
		ErrTerminal:       {http.StatusConflict, "producer_conflict"},
		ErrProducerBusy:   {http.StatusConflict, "producer_conflict"},
		ErrUncertain:      {http.StatusConflict, "producer_conflict"},
		ErrRetired:        {http.StatusGone, "retired"},
		ErrCorrupt:        {http.StatusInternalServerError, "corrupt"},
	}
	for err, want := range cases {
		recorder := httptest.NewRecorder()
		producerError(recorder, fmt.Errorf("wrapped: %w", err))
		var body map[string]string
		_ = json.Unmarshal(recorder.Body.Bytes(), &body)
		if recorder.Code != want.status || body["code"] != want.code {
			t.Fatalf("%v -> %d %q, want %d %q", err, recorder.Code, body["code"], want.status, want.code)
		}
	}
}

// The public route caps bodies at middleware.MaxRequestBodySize. A turn
// request over that cap is a 413, whether the handler or the route cuts it.
func TestTurnRequestOverRouteCapIsTooLarge(t *testing.T) {
	oversized := `{"runId":"r","instructions":"","messages":[],"pad":"` + strings.Repeat("x", int(middleware.MaxRequestBodySize)) + `"}`
	for name, wrap := range map[string]func(http.ResponseWriter, *http.Request){
		"handler": func(http.ResponseWriter, *http.Request) {},
		"route": func(w http.ResponseWriter, r *http.Request) {
			r.Body = http.MaxBytesReader(w, r.Body, middleware.MaxRequestBodySize)
		},
	} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, TurnPath, strings.NewReader(oversized))
		wrap(recorder, request)
		if _, _, _, ok := readTurnRequest(recorder, request); ok || recorder.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("%s: oversized turn -> ok=%v status %d, want 413", name, ok, recorder.Code)
		}
	}
}

func TestTestDatabaseNamesCarryTheirAge(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	created, ok := testDatabaseCreated(testDatabaseName(now))
	if !ok || !created.Equal(now) {
		t.Fatalf("created = %v ok=%v", created, ok)
	}
	for _, name := range []string{"smithers_chat_0123abcd", "smithers_chat_x_y", "other_1_2"} {
		if _, ok := testDatabaseCreated(name); ok {
			t.Fatalf("%s parsed as a dated test database", name)
		}
	}
}
