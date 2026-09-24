package chat

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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
