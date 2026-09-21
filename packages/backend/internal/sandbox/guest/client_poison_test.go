package guest

import (
	"context"
	"net"
	"strings"
	"testing"
	"time"
)

// mismatchedIDGuest answers MethodHello correctly so negotiation succeeds,
// then replies to every later request with a stale/mismatched response ID —
// simulating a timed-out RPC whose late response is still on the wire.
func mismatchedIDGuest(t *testing.T, conn net.Conn) {
	t.Helper()
	go func() {
		defer conn.Close()
		for {
			var req Request
			if err := ReadMessage(conn, &req); err != nil {
				return
			}
			resp := Response{ID: req.ID}
			if req.Method == MethodHello {
				resp.Result = MarshalResult(HelloResponse{
					ProtocolVersion:      ProtocolVersion,
					MinCompatibleVersion: MinCompatibleVersion,
					GuestAgentVersion:    "test",
					Capabilities:         CurrentCapabilities(),
				})
			} else {
				resp.ID = "stale-id"
				resp.Result = MarshalResult(PingResponse{Pong: true})
			}
			if err := WriteMessage(conn, &resp); err != nil {
				return
			}
		}
	}()
}

// A response id mismatch means the transport is desynced (e.g. a previous
// call timed out and its response is still buffered). The client must poison
// the connection so callers reconnect, instead of every subsequent call
// failing with "response id mismatch" against shifted responses.
func TestRoundTrip_IDMismatch_PoisonsTransport(t *testing.T) {
	ctx := context.Background()
	cConn, sConn := pipePair()
	mismatchedIDGuest(t, sConn)

	c := NewClient(cConn)
	c.SetTimeout(2 * time.Second)

	var pong PingResponse
	err := c.Invoke(ctx, MethodPing, MethodPing, nil, &pong)
	if err == nil || !strings.Contains(err.Error(), "response id mismatch") {
		t.Fatalf("Invoke = %v, want response id mismatch", err)
	}

	// The transport must now be marked broken: later calls fail fast with a
	// reconnect-required error rather than reading desynced responses.
	err = c.Invoke(ctx, MethodPing, MethodPing, nil, &pong)
	if err == nil || !strings.Contains(err.Error(), "broken") {
		t.Fatalf("second Invoke = %v, want broken-transport error", err)
	}
}
