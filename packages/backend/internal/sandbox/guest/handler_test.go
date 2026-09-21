package guest

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"sort"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// --- Test infrastructure -----------------------------------------------------

// pipePair returns two connected net.Conns suitable as Client.Transport and
// as the server-side connection fed into a handler loop.
func pipePair() (clientConn, serverConn net.Conn) {
	return net.Pipe()
}

// runNewGuest serves requests from conn using a real Handler. It exits when
// conn closes.
func runNewGuest(ctx context.Context, t *testing.T, conn net.Conn, h *Handler) {
	t.Helper()
	go func() {
		defer conn.Close()
		for {
			var req Request
			if err := ReadMessage(conn, &req); err != nil {
				return
			}
			resp := h.HandleRequest(ctx, &req)
			if err := WriteMessage(conn, resp); err != nil {
				return
			}
		}
	}()
}

// legacyGuest mimics the pre-0131 handler behavior: it responds to the
// documented legacy method set, returns the bare "unknown method: X" error
// for anything else (including MethodHello), and populates NO ErrorCode.
func legacyGuest(t *testing.T, conn net.Conn) {
	t.Helper()
	go func() {
		defer conn.Close()
		for {
			var req Request
			if err := ReadMessage(conn, &req); err != nil {
				return
			}
			resp := Response{ID: req.ID}
			switch req.Method {
			case MethodPing:
				resp.Result = MarshalResult(PingResponse{Pong: true})
			case MethodReady:
				resp.Result = MarshalResult(ReadyResponse{Ready: true})
			default:
				// The exact shape pre-0131 produced — no error_code.
				resp.Error = "unknown method: " + req.Method
			}
			if err := WriteMessage(conn, &resp); err != nil {
				return
			}
		}
	}()
}

func newTestClient(t *testing.T, conn net.Conn) *Client {
	t.Helper()
	c := NewClient(conn)
	c.SetTimeout(2 * time.Second)
	t.Cleanup(func() { _ = c.Close() })
	return c
}

// --- Tests -------------------------------------------------------------------

// Acceptance: new host -> new guest — handshake succeeds, capabilities
// advertised.
func TestHandshake_NewHostNewGuest(t *testing.T) {
	ctx := context.Background()
	cConn, sConn := pipePair()

	h := NewHandler(time.Hour)
	runNewGuest(ctx, t, sConn, h)

	c := newTestClient(t, cConn)

	if err := c.Negotiate(ctx); err != nil {
		t.Fatalf("Negotiate: %v", err)
	}

	if got, want := c.ProtocolVersion(), ProtocolVersion; got != want {
		t.Errorf("ProtocolVersion = %d, want %d", got, want)
	}
	if c.IsLegacy() {
		t.Error("IsLegacy = true, want false for new guest")
	}

	// Every legacy method must be in the advertised capability set.
	for _, cap := range LegacyCapabilities {
		if !c.HasCapability(cap) {
			t.Errorf("missing capability %q from new-guest advertisement", cap)
		}
	}

	// Capabilities() snapshot should match CurrentCapabilities exactly.
	gotCaps := c.Capabilities()
	sort.Strings(gotCaps)
	wantCaps := append([]string(nil), CurrentCapabilities()...)
	sort.Strings(wantCaps)
	if len(gotCaps) != len(wantCaps) {
		t.Fatalf("Capabilities len = %d, want %d (%v vs %v)", len(gotCaps), len(wantCaps), gotCaps, wantCaps)
	}
	for i := range gotCaps {
		if gotCaps[i] != wantCaps[i] {
			t.Errorf("Capabilities[%d] = %q, want %q", i, gotCaps[i], wantCaps[i])
		}
	}
}

// Acceptance: new host -> old guest. MethodHello returns "unknown method",
// client falls back to LegacyCapabilities.
func TestHandshake_NewHostOldGuest_LegacyFallback(t *testing.T) {
	ctx := context.Background()
	cConn, sConn := pipePair()
	legacyGuest(t, sConn)

	c := newTestClient(t, cConn)
	if err := c.Negotiate(ctx); err != nil {
		t.Fatalf("Negotiate fallback: %v", err)
	}
	if !c.IsLegacy() {
		t.Error("IsLegacy = false, want true for pre-0131 guest")
	}
	if got, want := c.ProtocolVersion(), LegacyProtocolVersion; got != want {
		t.Errorf("ProtocolVersion = %d, want %d", got, want)
	}
	// Legacy baseline must include the pre-0131 method set and must NOT
	// include capability placeholders for 0107/0110.
	for _, cap := range LegacyCapabilities {
		if !c.HasCapability(cap) {
			t.Errorf("legacy baseline missing %q", cap)
		}
	}
	if c.HasCapability(CapabilityDevtoolsSnapshotsWrite) {
		t.Error("legacy baseline must not include devtools_snapshots.write")
	}
	if c.HasCapability(CapabilityApprovalsEmit) {
		t.Error("legacy baseline must not include approvals.emit")
	}
}

// Acceptance: gated Invoke against a guest that has NOT advertised the
// capability must fail as feature-unavailable, not as a transport crash
// nor an unknown-method cascade on the wire. We use a stub guest that
// returns a deliberately minimal capability list.
func TestInvoke_GatedMethodWithoutCapability(t *testing.T) {
	ctx := context.Background()
	cConn, sConn := pipePair()
	// Stub guest that advertises only Ping. Mirrors the legacyGuest
	// helper but keeps MethodHello reachable so Negotiate succeeds.
	go func() {
		defer sConn.Close()
		for {
			var req Request
			if err := ReadMessage(sConn, &req); err != nil {
				return
			}
			resp := Response{ID: req.ID}
			switch req.Method {
			case MethodHello:
				resp.Result = MarshalResult(HelloResponse{
					ProtocolVersion:      ProtocolVersion,
					MinCompatibleVersion: MinCompatibleVersion,
					GuestAgentVersion:    "test-empty-caps",
					Capabilities:         []string{MethodPing},
				})
			case MethodPing:
				resp.Result = MarshalResult(PingResponse{Pong: true})
			default:
				resp.Error = "unknown method: " + req.Method
				resp.ErrorCode = ErrorCodeUnknownMethod
			}
			if err := WriteMessage(sConn, &resp); err != nil {
				return
			}
		}
	}()

	c := newTestClient(t, cConn)
	if err := c.Negotiate(ctx); err != nil {
		t.Fatalf("Negotiate: %v", err)
	}

	// The stub advertised only Ping; the gated Invoke must short-circuit
	// locally rather than crossing the wire.
	err := c.Invoke(ctx, MethodWriteDevtoolsSnapshot, CapabilityDevtoolsSnapshotsWrite, nil, nil)
	if !errors.Is(err, ErrCapabilityUnavailable) {
		t.Fatalf("expected ErrCapabilityUnavailable, got %v", err)
	}

	// And a PingResponse round-trip still works on the same connection —
	// proving the gated failure didn't crash the connection or poison the
	// handshake cache.
	var pr PingResponse
	if err := c.Invoke(ctx, MethodPing, MethodPing, nil, &pr); err != nil {
		t.Fatalf("Ping after gated failure: %v", err)
	}
	if !pr.Pong {
		t.Error("Ping.Pong = false, want true")
	}
}

// Acceptance: if the host skips capability gating and invokes an unknown
// method, the new guest returns a structured ErrorCodeUnknownMethod, which
// the client surfaces as ErrCapabilityUnavailable — NOT a crash.
func TestInvoke_UnknownMethod_StructuredError(t *testing.T) {
	ctx := context.Background()
	cConn, sConn := pipePair()
	h := NewHandler(time.Hour)
	runNewGuest(ctx, t, sConn, h)

	c := newTestClient(t, cConn)
	if err := c.Negotiate(ctx); err != nil {
		t.Fatalf("Negotiate: %v", err)
	}

	// Bypass gating by passing an empty requiredCapability; the server
	// should respond with ErrorCodeUnknownMethod, which the client
	// translates to ErrCapabilityUnavailable.
	err := c.Invoke(ctx, "NotARealMethod", "", nil, nil)
	if !errors.Is(err, ErrCapabilityUnavailable) {
		t.Fatalf("expected ErrCapabilityUnavailable, got %v", err)
	}
}

// Acceptance: if the guest returns structured unsupported_capability, the
// host surfaces feature-unavailable rather than a generic transport failure.
func TestInvoke_UnsupportedCapability_StructuredError(t *testing.T) {
	ctx := context.Background()
	cConn, sConn := pipePair()
	go func() {
		defer sConn.Close()
		for {
			var req Request
			if err := ReadMessage(sConn, &req); err != nil {
				return
			}
			resp := Response{ID: req.ID}
			switch req.Method {
			case MethodHello:
				resp.Result = MarshalResult(HelloResponse{
					ProtocolVersion:      ProtocolVersion,
					MinCompatibleVersion: MinCompatibleVersion,
					GuestAgentVersion:    "unsupported-capability-test",
					Capabilities:         CurrentCapabilities(),
				})
			case MethodWriteDevtoolsSnapshot:
				resp.Error = "unsupported capability: " + CapabilityDevtoolsSnapshotsWrite
				resp.ErrorCode = ErrorCodeUnsupportedCapability
			default:
				resp.Error = "unknown method: " + req.Method
				resp.ErrorCode = ErrorCodeUnknownMethod
			}
			if err := WriteMessage(sConn, &resp); err != nil {
				return
			}
		}
	}()

	c := newTestClient(t, cConn)
	if err := c.Negotiate(ctx); err != nil {
		t.Fatalf("Negotiate: %v", err)
	}

	err := c.Invoke(ctx, MethodWriteDevtoolsSnapshot, "", nil, nil)
	if !errors.Is(err, ErrCapabilityUnavailable) {
		t.Fatalf("expected ErrCapabilityUnavailable, got %v", err)
	}
}

// Acceptance: regression — old guest's existing methods still work after the
// host falls back to the legacy baseline.
func TestLegacyGuest_ExistingMethodsStillWork(t *testing.T) {
	ctx := context.Background()
	cConn, sConn := pipePair()
	legacyGuest(t, sConn)

	c := newTestClient(t, cConn)
	if err := c.Negotiate(ctx); err != nil {
		t.Fatalf("Negotiate fallback: %v", err)
	}

	var pr PingResponse
	if err := c.Invoke(ctx, MethodPing, MethodPing, nil, &pr); err != nil {
		t.Fatalf("Ping on legacy guest: %v", err)
	}
	if !pr.Pong {
		t.Error("Ping.Pong = false, want true")
	}

	var rr ReadyResponse
	if err := c.Invoke(ctx, MethodReady, MethodReady, nil, &rr); err != nil {
		t.Fatalf("Ready on legacy guest: %v", err)
	}
	if !rr.Ready {
		t.Error("Ready.Ready = false, want true")
	}
}

// Negotiate is idempotent — calling it twice does not re-issue Hello on the
// wire.
func TestNegotiate_Idempotent(t *testing.T) {
	ctx := context.Background()
	cConn, sConn := pipePair()
	h := NewHandler(time.Hour)
	runNewGuest(ctx, t, sConn, h)

	c := newTestClient(t, cConn)
	if err := c.Negotiate(ctx); err != nil {
		t.Fatalf("Negotiate 1: %v", err)
	}
	if err := c.Negotiate(ctx); err != nil {
		t.Fatalf("Negotiate 2: %v", err)
	}
}

// Negotiate is also idempotent under concurrency: multiple callers racing
// must result in exactly one MethodHello on the wire for this connection.
func TestNegotiate_ConcurrentSingleProbe(t *testing.T) {
	ctx := context.Background()
	cConn, sConn := pipePair()

	var helloCalls atomic.Int32
	go func() {
		defer sConn.Close()
		for {
			var req Request
			if err := ReadMessage(sConn, &req); err != nil {
				return
			}
			resp := Response{ID: req.ID}
			switch req.Method {
			case MethodHello:
				helloCalls.Add(1)
				resp.Result = MarshalResult(HelloResponse{
					ProtocolVersion:      ProtocolVersion,
					MinCompatibleVersion: MinCompatibleVersion,
					GuestAgentVersion:    "concurrency-test",
					Capabilities:         CurrentCapabilities(),
				})
			case MethodPing:
				resp.Result = MarshalResult(PingResponse{Pong: true})
			default:
				resp.Error = "unknown method: " + req.Method
				resp.ErrorCode = ErrorCodeUnknownMethod
			}
			if err := WriteMessage(sConn, &resp); err != nil {
				return
			}
		}
	}()

	c := newTestClient(t, cConn)

	const callers = 8
	var wg sync.WaitGroup
	wg.Add(callers)
	errs := make(chan error, callers)
	for i := 0; i < callers; i++ {
		go func() {
			defer wg.Done()
			errs <- c.Negotiate(ctx)
		}()
	}
	wg.Wait()
	close(errs)

	for err := range errs {
		if err != nil {
			t.Fatalf("Negotiate (concurrent): %v", err)
		}
	}
	if got := helloCalls.Load(); got != 1 {
		t.Fatalf("MethodHello call count = %d, want 1", got)
	}
}

// Invoke auto-negotiates: the first call must issue exactly one MethodHello,
// then execute the requested method on the same connection.
func TestInvoke_AutoNegotiatesAndCaches(t *testing.T) {
	ctx := context.Background()
	cConn, sConn := pipePair()

	var helloCalls atomic.Int32
	go func() {
		defer sConn.Close()
		for {
			var req Request
			if err := ReadMessage(sConn, &req); err != nil {
				return
			}
			resp := Response{ID: req.ID}
			switch req.Method {
			case MethodHello:
				helloCalls.Add(1)
				resp.Result = MarshalResult(HelloResponse{
					ProtocolVersion:      ProtocolVersion,
					MinCompatibleVersion: MinCompatibleVersion,
					GuestAgentVersion:    "auto-negotiate-test",
					Capabilities:         CurrentCapabilities(),
				})
			case MethodPing:
				resp.Result = MarshalResult(PingResponse{Pong: true})
			default:
				resp.Error = "unknown method: " + req.Method
				resp.ErrorCode = ErrorCodeUnknownMethod
			}
			if err := WriteMessage(sConn, &resp); err != nil {
				return
			}
		}
	}()

	c := newTestClient(t, cConn)

	var first PingResponse
	if err := c.Invoke(ctx, MethodPing, MethodPing, nil, &first); err != nil {
		t.Fatalf("first Invoke: %v", err)
	}
	if !first.Pong {
		t.Fatal("first ping returned pong=false")
	}

	var second PingResponse
	if err := c.Invoke(ctx, MethodPing, MethodPing, nil, &second); err != nil {
		t.Fatalf("second Invoke: %v", err)
	}
	if !second.Pong {
		t.Fatal("second ping returned pong=false")
	}

	if got := helloCalls.Load(); got != 1 {
		t.Fatalf("MethodHello call count = %d, want 1", got)
	}
}

// Direct handler test: a Hello request returns a well-formed HelloResponse
// with the current capability set.
func TestHandler_HelloDirect(t *testing.T) {
	h := NewHandler(time.Hour)
	req := &Request{ID: "1", Method: MethodHello, Params: MarshalResult(HelloRequest{})}
	resp := h.HandleRequest(context.Background(), req)
	if resp.Error != "" || resp.ErrorCode != "" {
		t.Fatalf("unexpected error: %q / %q", resp.Error, resp.ErrorCode)
	}
	var hr HelloResponse
	if err := json.Unmarshal(resp.Result, &hr); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if hr.ProtocolVersion != ProtocolVersion {
		t.Errorf("ProtocolVersion = %d, want %d", hr.ProtocolVersion, ProtocolVersion)
	}
	if len(hr.Capabilities) == 0 {
		t.Error("Capabilities empty")
	}
}

// Direct handler test: an unknown method returns ErrorCodeUnknownMethod AND
// the legacy free-form Error message (for pre-structured clients).
func TestHandler_UnknownMethodErrorCode(t *testing.T) {
	h := NewHandler(time.Hour)
	req := &Request{ID: "1", Method: "DoesNotExist"}
	resp := h.HandleRequest(context.Background(), req)
	if resp.ErrorCode != ErrorCodeUnknownMethod {
		t.Errorf("ErrorCode = %q, want %q", resp.ErrorCode, ErrorCodeUnknownMethod)
	}
	if resp.Error == "" {
		t.Error("Error must remain populated for legacy-client compatibility")
	}
}

// -----------------------------------------------------------------------------
// Ticket 0110: approvals.emit capability + MethodEmitApprovalRequest.
// -----------------------------------------------------------------------------

// approvals.emit must NOT be advertised until a host-side forwarder persists
// emissions through internal/services/approvals.go — otherwise a runtime's
// approval request is ACKed locally and silently dropped, bypassing the
// human-in-the-loop gate. Re-invert this test in the ticket that ships the
// forwarder.
func TestCurrentCapabilities_ExcludesApprovalsEmit(t *testing.T) {
	for _, c := range CurrentCapabilities() {
		if c == CapabilityApprovalsEmit {
			t.Fatalf("CurrentCapabilities() advertises %q, but no forwarder persists emissions yet", CapabilityApprovalsEmit)
		}
	}
}

// End-to-end (in-process pipe): a gated EmitApprovalRequest invocation against
// a current guest fails fast as capability-unavailable instead of returning a
// local-only ACK that no forwarder will ever persist.
func TestInvoke_EmitApprovalRequest_NewGuest_CapabilityGated(t *testing.T) {
	ctx := context.Background()
	cConn, sConn := pipePair()
	h := NewHandler(time.Hour)
	runNewGuest(ctx, t, sConn, h)

	c := newTestClient(t, cConn)
	if err := c.Negotiate(ctx); err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	if c.HasCapability(CapabilityApprovalsEmit) {
		t.Fatalf("current guest must not advertise %q until the forwarder exists", CapabilityApprovalsEmit)
	}

	params := EmitApprovalRequestRequest{
		SessionID: "11111111-2222-3333-4444-555555555555",
		Kind:      "shell_command",
		Title:     "run installer",
		Payload:   json.RawMessage(`{"cmd":"install"}`),
	}
	err := c.Invoke(ctx, MethodEmitApprovalRequest, CapabilityApprovalsEmit, params, nil)
	if !errors.Is(err, ErrCapabilityUnavailable) {
		t.Fatalf("expected ErrCapabilityUnavailable, got %v", err)
	}
}

// Capability gate: talking to a legacy guest (no approvals.emit capability
// advertised), the client MUST refuse to send MethodEmitApprovalRequest.
// This is the core invariant from the ticket — "host MUST NOT invoke" when
// the capability isn't negotiated.
func TestInvoke_EmitApprovalRequest_LegacyGuest_CapabilityGated(t *testing.T) {
	ctx := context.Background()
	cConn, sConn := pipePair()
	legacyGuest(t, sConn)

	c := newTestClient(t, cConn)
	if err := c.Negotiate(ctx); err != nil {
		t.Fatalf("Negotiate fallback: %v", err)
	}
	if c.HasCapability(CapabilityApprovalsEmit) {
		t.Fatal("legacy baseline must NOT advertise approvals.emit")
	}

	// Must be a local short-circuit — the legacy guest loop never receives
	// the RPC on the wire.
	err := c.Invoke(ctx, MethodEmitApprovalRequest, CapabilityApprovalsEmit, EmitApprovalRequestRequest{
		SessionID: "11111111-2222-3333-4444-555555555555",
		Kind:      "file_write",
		Title:     "write foo.txt",
	}, nil)
	if !errors.Is(err, ErrCapabilityUnavailable) {
		t.Fatalf("expected ErrCapabilityUnavailable, got %v", err)
	}
}

// Validation: missing required fields return ErrorCodeInvalidParams. The
// guest never accepts a malformed emission — Smithers's service layer re-checks
// but the guest is the first line of defense.
func TestHandler_EmitApprovalRequest_Validation(t *testing.T) {
	h := NewHandler(time.Hour)

	// Well-formed-envelope cases: these marshal cleanly but trip the
	// handler's field checks.
	fieldTests := []struct {
		name   string
		params EmitApprovalRequestRequest
	}{
		{"missing session_id", EmitApprovalRequestRequest{Kind: "k", Title: "t"}},
		{"missing kind", EmitApprovalRequestRequest{SessionID: "s", Title: "t"}},
		{"missing title", EmitApprovalRequestRequest{SessionID: "s", Kind: "k"}},
		{"bad expires_at", EmitApprovalRequestRequest{SessionID: "s", Kind: "k", Title: "t", ExpiresAt: "not-a-date"}},
	}
	for _, tc := range fieldTests {
		t.Run(tc.name, func(t *testing.T) {
			req := &Request{
				ID:     "r1",
				Method: MethodEmitApprovalRequest,
				Params: MarshalResult(tc.params),
			}
			resp := h.HandleRequest(context.Background(), req)
			if resp.ErrorCode != ErrorCodeInvalidParams {
				t.Fatalf("ErrorCode = %q, want %q (Error=%q)", resp.ErrorCode, ErrorCodeInvalidParams, resp.Error)
			}
		})
	}

	// Malformed-payload case: craft the outer envelope by hand so the
	// payload field contains invalid JSON. unmarshalParams rejects it at
	// envelope-parse time, which is what we want — the guest never
	// forwards a syntactically-invalid emission.
	t.Run("invalid JSON payload rejected at envelope parse", func(t *testing.T) {
		req := &Request{
			ID:     "r1",
			Method: MethodEmitApprovalRequest,
			Params: []byte(`{"session_id":"s","kind":"k","title":"t","payload":{nope}}`),
		}
		resp := h.HandleRequest(context.Background(), req)
		if resp.ErrorCode != ErrorCodeInvalidParams {
			t.Fatalf("ErrorCode = %q, want %q (Error=%q)", resp.ErrorCode, ErrorCodeInvalidParams, resp.Error)
		}
	})
}

// Happy path: a well-formed direct HandleRequest returns accepted=true.
func TestHandler_EmitApprovalRequest_Accepts(t *testing.T) {
	h := NewHandler(time.Hour)
	params := EmitApprovalRequestRequest{
		SessionID:   "11111111-2222-3333-4444-555555555555",
		Kind:        "network_call",
		Title:       "POST to webhook",
		Description: "Agent wants to call an external webhook",
		Payload:     json.RawMessage(`{"url":"https://example.com"}`),
	}
	req := &Request{ID: "r1", Method: MethodEmitApprovalRequest, Params: MarshalResult(params)}
	resp := h.HandleRequest(context.Background(), req)
	if resp.Error != "" || resp.ErrorCode != "" {
		t.Fatalf("unexpected error: %q / %q", resp.Error, resp.ErrorCode)
	}
	var out EmitApprovalRequestResponse
	if err := json.Unmarshal(resp.Result, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !out.Accepted {
		t.Error("Accepted = false, want true")
	}
}

// -----------------------------------------------------------------------------
// Ticket 0107: devtools_snapshots.write capability + MethodWriteDevtoolsSnapshot.
// -----------------------------------------------------------------------------

// devtools_snapshots.write must NOT be advertised until a host-side forwarder
// persists snapshots through internal/services/devtools.go — otherwise a
// runtime's snapshot is ACKed locally and lost. Re-invert this test in the
// ticket that ships the forwarder.
func TestCurrentCapabilities_ExcludesDevtoolsSnapshotsWrite(t *testing.T) {
	for _, c := range CurrentCapabilities() {
		if c == CapabilityDevtoolsSnapshotsWrite {
			t.Fatalf("CurrentCapabilities() advertises %q, but no forwarder persists snapshots yet", CapabilityDevtoolsSnapshotsWrite)
		}
	}
}

// End-to-end (in-process pipe): a gated WriteDevtoolsSnapshot invocation
// against a current guest fails fast as capability-unavailable instead of
// returning a local-only ACK that no forwarder will ever persist.
func TestInvoke_WriteDevtoolsSnapshot_NewGuest_CapabilityGated(t *testing.T) {
	ctx := context.Background()
	cConn, sConn := pipePair()
	h := NewHandler(time.Hour)
	runNewGuest(ctx, t, sConn, h)

	c := newTestClient(t, cConn)
	if err := c.Negotiate(ctx); err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	if c.HasCapability(CapabilityDevtoolsSnapshotsWrite) {
		t.Fatalf("current guest must not advertise %q until the forwarder exists", CapabilityDevtoolsSnapshotsWrite)
	}

	params := WriteDevtoolsSnapshotRequest{
		SessionID: "11111111-2222-3333-4444-555555555555",
		Kind:      "file_tree",
		Payload:   json.RawMessage(`{"root":"src","files":["main.go"]}`),
	}
	err := c.Invoke(ctx, MethodWriteDevtoolsSnapshot, CapabilityDevtoolsSnapshotsWrite, params, nil)
	if !errors.Is(err, ErrCapabilityUnavailable) {
		t.Fatalf("expected ErrCapabilityUnavailable, got %v", err)
	}
}

// Capability gate: talking to a legacy guest (no devtools_snapshots.write
// capability advertised), the client MUST refuse to send
// MethodWriteDevtoolsSnapshot. This is the core invariant from the ticket —
// "without CapabilityDevtoolsSnapshotsWrite, host MUST NOT invoke
// MethodWriteDevtoolsSnapshot".
func TestInvoke_WriteDevtoolsSnapshot_LegacyGuest_CapabilityGated(t *testing.T) {
	ctx := context.Background()
	cConn, sConn := pipePair()
	legacyGuest(t, sConn)

	c := newTestClient(t, cConn)
	if err := c.Negotiate(ctx); err != nil {
		t.Fatalf("Negotiate fallback: %v", err)
	}
	if c.HasCapability(CapabilityDevtoolsSnapshotsWrite) {
		t.Fatal("legacy baseline must NOT advertise devtools_snapshots.write")
	}

	// Must be a local short-circuit — the legacy guest loop never receives
	// the RPC on the wire.
	err := c.Invoke(ctx, MethodWriteDevtoolsSnapshot, CapabilityDevtoolsSnapshotsWrite, WriteDevtoolsSnapshotRequest{
		SessionID: "11111111-2222-3333-4444-555555555555",
		Kind:      "screenshot",
	}, nil)
	if !errors.Is(err, ErrCapabilityUnavailable) {
		t.Fatalf("expected ErrCapabilityUnavailable, got %v", err)
	}
}

// Validation: malformed requests return ErrorCodeInvalidParams. The guest is
// the first line of defense; Smithers's service layer re-validates.
func TestHandler_WriteDevtoolsSnapshot_Validation(t *testing.T) {
	h := NewHandler(time.Hour)

	fieldTests := []struct {
		name   string
		params WriteDevtoolsSnapshotRequest
	}{
		{"missing session_id", WriteDevtoolsSnapshotRequest{Kind: "file_tree"}},
		{"missing kind", WriteDevtoolsSnapshotRequest{SessionID: "s"}},
		{"kind not in enum", WriteDevtoolsSnapshotRequest{SessionID: "s", Kind: "telemetry"}},
		{"payload not an object (array)", WriteDevtoolsSnapshotRequest{
			SessionID: "s", Kind: "file_tree", Payload: json.RawMessage(`[1,2,3]`),
		}},
		{"payload not an object (scalar)", WriteDevtoolsSnapshotRequest{
			SessionID: "s", Kind: "file_tree", Payload: json.RawMessage(`"hi"`),
		}},
	}
	for _, tc := range fieldTests {
		t.Run(tc.name, func(t *testing.T) {
			req := &Request{
				ID:     "r1",
				Method: MethodWriteDevtoolsSnapshot,
				Params: MarshalResult(tc.params),
			}
			resp := h.HandleRequest(context.Background(), req)
			if resp.ErrorCode != ErrorCodeInvalidParams {
				t.Fatalf("ErrorCode = %q, want %q (Error=%q)", resp.ErrorCode, ErrorCodeInvalidParams, resp.Error)
			}
		})
	}

	t.Run("oversized payload rejected", func(t *testing.T) {
		// 256KiB + 1 byte, wrapped so it parses as a JSON object. We build
		// the JSON around a filler string to exceed the cap deterministically.
		filler := make([]byte, 256*1024)
		for i := range filler {
			filler[i] = 'a'
		}
		payload := append([]byte(`{"x":"`), filler...)
		payload = append(payload, []byte(`"}`)...)
		req := &Request{
			ID:     "r1",
			Method: MethodWriteDevtoolsSnapshot,
			Params: MarshalResult(WriteDevtoolsSnapshotRequest{
				SessionID: "s",
				Kind:      "file_tree",
				Payload:   payload,
			}),
		}
		resp := h.HandleRequest(context.Background(), req)
		if resp.ErrorCode != ErrorCodeInvalidParams {
			t.Fatalf("ErrorCode = %q, want %q (Error=%q)", resp.ErrorCode, ErrorCodeInvalidParams, resp.Error)
		}
	})

	t.Run("invalid JSON payload rejected at envelope parse", func(t *testing.T) {
		req := &Request{
			ID:     "r1",
			Method: MethodWriteDevtoolsSnapshot,
			Params: []byte(`{"session_id":"s","kind":"file_tree","payload":{nope}}`),
		}
		resp := h.HandleRequest(context.Background(), req)
		if resp.ErrorCode != ErrorCodeInvalidParams {
			t.Fatalf("ErrorCode = %q, want %q (Error=%q)", resp.ErrorCode, ErrorCodeInvalidParams, resp.Error)
		}
	})
}

// Happy path: well-formed direct HandleRequest returns accepted=true for
// every kind in the closed enum.
func TestHandler_WriteDevtoolsSnapshot_Accepts(t *testing.T) {
	h := NewHandler(time.Hour)
	for _, kind := range []string{"file_tree", "screenshot", "command_output", "tool_state"} {
		kind := kind
		t.Run(kind, func(t *testing.T) {
			params := WriteDevtoolsSnapshotRequest{
				SessionID: "11111111-2222-3333-4444-555555555555",
				Kind:      kind,
				Payload:   json.RawMessage(`{"k":"v"}`),
			}
			req := &Request{ID: "r1", Method: MethodWriteDevtoolsSnapshot, Params: MarshalResult(params)}
			resp := h.HandleRequest(context.Background(), req)
			if resp.Error != "" || resp.ErrorCode != "" {
				t.Fatalf("unexpected error for kind %q: %q / %q", kind, resp.Error, resp.ErrorCode)
			}
			var out WriteDevtoolsSnapshotResponse
			if err := json.Unmarshal(resp.Result, &out); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if !out.Accepted {
				t.Error("Accepted = false, want true")
			}
		})
	}
}
