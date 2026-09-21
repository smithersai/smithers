package guest

import (
	"context"
	"errors"
	"net"
	"strings"
	"testing"
	"time"
)

// clientCoverServe runs a stub guest that replies to each request using fn. If
// fn returns nil the loop closes the connection without answering (simulating a
// dropped/timed-out RPC). It reuses pipePair from handler_test.go.
func clientCoverServe(t *testing.T, conn net.Conn, fn func(req *Request) *Response) {
	t.Helper()
	go func() {
		defer conn.Close()
		for {
			var req Request
			if err := ReadMessage(conn, &req); err != nil {
				return
			}
			resp := fn(&req)
			if resp == nil {
				return
			}
			if err := WriteMessage(conn, resp); err != nil {
				return
			}
		}
	}()
}

// clientCoverHelloOK returns a well-formed HelloResponse for MethodHello and
// delegates every other method to next.
func clientCoverHelloOK(next func(req *Request) *Response) func(req *Request) *Response {
	return func(req *Request) *Response {
		if req.Method == MethodHello {
			return &Response{ID: req.ID, Result: MarshalResult(HelloResponse{
				ProtocolVersion:      ProtocolVersion,
				MinCompatibleVersion: MinCompatibleVersion,
				GuestAgentVersion:    "client-cover",
				Capabilities:         CurrentCapabilities(),
			})}
		}
		return next(req)
	}
}

// Negotiate: a transport that fails to write surfaces a hello error and
// poisons the client so a follow-up call fails fast with "broken".
func TestClientCover_Negotiate_WriteError_Poisons(t *testing.T) {
	ctx := context.Background()
	cConn, sConn := pipePair()
	_ = sConn.Close() // server gone: the client's write will fail

	c := NewClient(cConn)
	c.SetTimeout(2 * time.Second)
	t.Cleanup(func() { _ = c.Close() })

	err := c.Negotiate(ctx)
	if err == nil || !strings.Contains(err.Error(), "write request") {
		t.Fatalf("Negotiate = %v, want write request error", err)
	}

	// Poisoned: a second attempt short-circuits with a broken-transport error.
	err = c.Negotiate(ctx)
	if err == nil || !strings.Contains(err.Error(), "broken") {
		t.Fatalf("second Negotiate = %v, want broken transport error", err)
	}
}

// Negotiate: the guest reads the hello then closes without replying, forcing a
// read error and poisoning the transport.
func TestClientCover_Negotiate_ReadError_Poisons(t *testing.T) {
	ctx := context.Background()
	cConn, sConn := pipePair()
	clientCoverServe(t, sConn, func(req *Request) *Response {
		return nil // read, then hang up with no response
	})

	c := NewClient(cConn)
	c.SetTimeout(2 * time.Second)
	t.Cleanup(func() { _ = c.Close() })

	err := c.Negotiate(ctx)
	if err == nil || !strings.Contains(err.Error(), "read response") {
		t.Fatalf("Negotiate = %v, want read response error", err)
	}
	err = c.Invoke(ctx, MethodPing, MethodPing, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "broken") {
		t.Fatalf("Invoke after poison = %v, want broken transport error", err)
	}
}

// Negotiate: a hello reply that is a syntactically valid message but not a
// HelloResponse surfaces a decode error.
func TestClientCover_Negotiate_DecodeError(t *testing.T) {
	ctx := context.Background()
	cConn, sConn := pipePair()
	clientCoverServe(t, sConn, func(req *Request) *Response {
		// Result is valid JSON but not an object → cannot decode into
		// HelloResponse.
		return &Response{ID: req.ID, Result: []byte(`"not-a-hello-object"`)}
	})

	c := NewClient(cConn)
	c.SetTimeout(2 * time.Second)
	t.Cleanup(func() { _ = c.Close() })

	err := c.Negotiate(ctx)
	if err == nil || !strings.Contains(err.Error(), "decode response") {
		t.Fatalf("Negotiate = %v, want decode response error", err)
	}
}

// Negotiate: an error reply that is neither a structured unknown-method code
// nor the legacy "unknown method:" prefix is a hard failure (not a legacy
// fallback).
func TestClientCover_Negotiate_NonLegacyError_HardFails(t *testing.T) {
	ctx := context.Background()
	cConn, sConn := pipePair()
	clientCoverServe(t, sConn, func(req *Request) *Response {
		return &Response{ID: req.ID, Error: "guest exploded"}
	})

	c := NewClient(cConn)
	c.SetTimeout(2 * time.Second)
	t.Cleanup(func() { _ = c.Close() })

	err := c.Negotiate(ctx)
	if err == nil || !strings.Contains(err.Error(), "guest exploded") {
		t.Fatalf("Negotiate = %v, want hard failure surfacing guest error", err)
	}
	if c.IsLegacy() {
		t.Error("IsLegacy = true, want false: a non-legacy error must not fall back")
	}
}

// Negotiate honors a context deadline that is earlier than the client's wire
// timeout, exercising the deadline-clamping branch in roundTrip.
func TestClientCover_Negotiate_ContextDeadlineClamped(t *testing.T) {
	ctx := context.Background()
	cConn, sConn := pipePair()
	h := NewHandler(time.Hour)
	clientCoverServe(t, sConn, func(req *Request) *Response {
		return h.HandleRequest(context.Background(), req)
	})

	c := NewClient(cConn)
	c.SetTimeout(30 * time.Second) // larger than the ctx deadline below
	t.Cleanup(func() { _ = c.Close() })

	dctx, cancel := context.WithTimeout(ctx, 1*time.Second)
	defer cancel()
	if err := c.Negotiate(dctx); err != nil {
		t.Fatalf("Negotiate with clamped deadline: %v", err)
	}
	if got := c.GuestAgentVersion(); got != GuestAgentVersion {
		t.Fatalf("GuestAgentVersion = %q, want %q", got, GuestAgentVersion)
	}
}

// Invoke returns the negotiate error (wrapped) when the handshake cannot
// complete.
func TestClientCover_Invoke_NegotiateFails(t *testing.T) {
	ctx := context.Background()
	cConn, sConn := pipePair()
	_ = sConn.Close()

	c := NewClient(cConn)
	c.SetTimeout(2 * time.Second)
	t.Cleanup(func() { _ = c.Close() })

	err := c.Invoke(ctx, MethodPing, MethodPing, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "negotiate") {
		t.Fatalf("Invoke = %v, want negotiate error", err)
	}
}

// Invoke surfaces a plain guest error (no structured capability code) as a
// generic "guest <method>: <error>".
func TestClientCover_Invoke_GenericGuestError(t *testing.T) {
	ctx := context.Background()
	cConn, sConn := pipePair()
	clientCoverServe(t, sConn, clientCoverHelloOK(func(req *Request) *Response {
		return &Response{ID: req.ID, Error: "kaboom", ErrorCode: ErrorCodeInternal}
	}))

	c := NewClient(cConn)
	c.SetTimeout(2 * time.Second)
	t.Cleanup(func() { _ = c.Close() })

	err := c.Invoke(ctx, MethodPing, MethodPing, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "kaboom") {
		t.Fatalf("Invoke = %v, want generic guest error", err)
	}
	if errors.Is(err, ErrCapabilityUnavailable) {
		t.Error("generic guest error must not be classified as capability-unavailable")
	}
}

// Invoke surfaces a decode error when the guest returns a success result that
// does not fit the caller's result type.
func TestClientCover_Invoke_DecodeResultError(t *testing.T) {
	ctx := context.Background()
	cConn, sConn := pipePair()
	clientCoverServe(t, sConn, clientCoverHelloOK(func(req *Request) *Response {
		// A JSON string cannot decode into a PingResponse struct.
		return &Response{ID: req.ID, Result: []byte(`"i-am-a-string"`)}
	}))

	c := NewClient(cConn)
	c.SetTimeout(2 * time.Second)
	t.Cleanup(func() { _ = c.Close() })

	var pr PingResponse
	err := c.Invoke(ctx, MethodPing, MethodPing, nil, &pr)
	if err == nil || !strings.Contains(err.Error(), "decode result") {
		t.Fatalf("Invoke = %v, want decode result error", err)
	}
}

// HasCapability returns false before Negotiate completes.
func TestClientCover_HasCapability_BeforeNegotiate(t *testing.T) {
	cConn, _ := pipePair()
	c := NewClient(cConn)
	t.Cleanup(func() { _ = c.Close() })
	if c.HasCapability(MethodPing) {
		t.Error("HasCapability = true before Negotiate, want false")
	}
	if v := c.GuestAgentVersion(); v != "" {
		t.Errorf("GuestAgentVersion before Negotiate = %q, want empty", v)
	}
}

// isLegacyUnknownMethod classifies each response shape correctly.
func TestClientCover_IsLegacyUnknownMethod(t *testing.T) {
	cases := []struct {
		name string
		resp Response
		want bool
	}{
		{"structured unknown_method code", Response{ErrorCode: ErrorCodeUnknownMethod}, true},
		{"other structured code is not legacy", Response{ErrorCode: ErrorCodeInternal, Error: "unknown method: X"}, false},
		{"legacy prefix with empty code", Response{Error: "unknown method: Foo"}, true},
		{"unrelated error with empty code", Response{Error: "disk on fire"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := tc.resp
			if got := isLegacyUnknownMethod(&resp); got != tc.want {
				t.Fatalf("isLegacyUnknownMethod(%+v) = %v, want %v", tc.resp, got, tc.want)
			}
		})
	}
}
