package guest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"time"
)

// ErrCapabilityUnavailable is returned by Client.Invoke when the host asks
// for a method whose capability has not been negotiated. Callers treat this
// as "feature unavailable," not a transport error.
var ErrCapabilityUnavailable = errors.New("guest: capability unavailable")

// ErrNotHandshaken is retained for backward compatibility with callers that
// explicitly enforced Negotiate-before-Invoke. Invoke now auto-negotiates and
// no longer returns this sentinel.
var ErrNotHandshaken = errors.New("guest: handshake not completed")

// Transport is the minimal I/O contract the host-side Client needs. A vsock
// connection satisfies this via net.Conn, but splitting it out lets tests
// inject an in-process pipe driven by a real *Handler.
type Transport interface {
	io.ReadWriteCloser
}

// Client is the host-side guest-agent RPC client. It is responsible for:
//
//   - running the MethodHello handshake exactly once per connection,
//   - caching the negotiated protocol version and capability set,
//   - refusing to send gated methods whose capability was not advertised,
//   - falling back to LegacyCapabilities when talking to a pre-MethodHello
//     guest (see Negotiate for the narrow, isolated string-match path).
//
// Invoke is safe for concurrent use; the underlying Transport is serialized
// by the client's write/read mutex.
type Client struct {
	t       Transport
	timeout time.Duration

	negMu     sync.Mutex // serializes MethodHello probing
	mu        sync.Mutex // serializes wire access
	idSeq     uint64
	broken    bool   // transport is poisoned (desynced or failed); callers must reconnect
	authToken string // control-plane token presented before Hello; empty = no auth
	handshake struct {
		done    bool
		version int
		minVer  int
		agent   string
		caps    map[string]struct{}
		legacy  bool // true if we fell back to LegacyCapabilities
	}
}

// NewClient wraps t. Invoke auto-runs Negotiate on first use, so callers can
// either probe explicitly (for diagnostics) or rely on lazy negotiation.
func NewClient(t Transport) *Client {
	return &Client{t: t, timeout: 30 * time.Second}
}

// SetTimeout overrides the default per-call wire timeout. Zero disables.
func (c *Client) SetTimeout(d time.Duration) { c.timeout = d }

// SetAuthToken configures the per-VM control-plane token. When set, Negotiate
// sends MethodAuthenticate before the Hello probe — a token-enforcing guest
// rejects every other method (and closes the connection) until the token has
// been presented. Call before the first Invoke/Negotiate.
func (c *Client) SetAuthToken(token string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.authToken = token
}

// Negotiate performs the MethodHello handshake. It caches the result so
// subsequent calls are no-ops. Talking to a pre-0131 guest (which answers
// with an unknown-method error) succeeds and populates the legacy capability
// baseline.
func (c *Client) Negotiate(ctx context.Context) error {
	c.negMu.Lock()
	defer c.negMu.Unlock()

	c.mu.Lock()
	if c.handshake.done {
		c.mu.Unlock()
		return nil
	}
	token := c.authToken
	c.mu.Unlock()

	// Present the control-plane token first: a token-enforcing guest rejects
	// every other method (including Hello) and closes the connection until
	// authentication succeeds.
	if token != "" {
		areq := Request{Method: MethodAuthenticate}
		areq.Params = MarshalResult(AuthenticateRequest{Token: token})
		aresp, err := c.roundTrip(ctx, areq)
		if err != nil {
			return fmt.Errorf("guest authenticate: %w", err)
		}
		if aresp.Error != "" {
			return fmt.Errorf("guest authenticate: %s", aresp.Error)
		}
	}

	req := Request{Method: MethodHello}
	req.Params = MarshalResult(HelloRequest{
		MinVersion: MinCompatibleVersion,
		MaxVersion: ProtocolVersion,
	})
	resp, err := c.roundTrip(ctx, req)
	if err != nil {
		return fmt.Errorf("guest hello: %w", err)
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	// Path 1: new guest — structured success.
	if resp.Error == "" && resp.ErrorCode == "" {
		var hr HelloResponse
		if err := json.Unmarshal(resp.Result, &hr); err != nil {
			return fmt.Errorf("guest hello: decode response: %w", err)
		}
		c.handshake.done = true
		c.handshake.version = hr.ProtocolVersion
		c.handshake.minVer = hr.MinCompatibleVersion
		c.handshake.agent = hr.GuestAgentVersion
		c.handshake.caps = setFromSlice(hr.Capabilities)
		c.handshake.legacy = false
		return nil
	}

	// Path 2: old guest — MethodHello unknown. Accept this exactly once, at
	// handshake time, using a narrow check:
	//   - a structured error_code == "unknown_method"  (never happens today
	//     because old guests don't populate error_code, but future-proofs
	//     against a hypothetical middle-version guest), OR
	//   - a bare error string starting with "unknown method:" produced by
	//     the pre-0131 handler (handler.go default branch).
	//
	// DELETION CRITERION: remove this legacy branch once every sandbox image
	// in production speaks MethodHello. At that point Negotiate should treat
	// an unknown-method response as a hard failure.
	if isLegacyUnknownMethod(resp) {
		c.handshake.done = true
		c.handshake.version = LegacyProtocolVersion
		c.handshake.minVer = LegacyProtocolVersion
		c.handshake.agent = "legacy"
		c.handshake.caps = setFromSlice(LegacyCapabilities)
		c.handshake.legacy = true
		return nil
	}

	// Any other error is a real transport/protocol failure.
	return fmt.Errorf("guest hello: %s", resp.Error)
}

// ProtocolVersion returns the negotiated version, or 0 before Negotiate.
func (c *Client) ProtocolVersion() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.handshake.version
}

// GuestAgentVersion returns the advertised guest-agent build string, or ""
// before Negotiate.
func (c *Client) GuestAgentVersion() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.handshake.agent
}

// IsLegacy reports whether Negotiate fell back to the pre-0131 capability
// baseline.
func (c *Client) IsLegacy() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.handshake.legacy
}

// HasCapability reports whether the negotiated guest advertises name.
// Safe to call before Negotiate (returns false).
func (c *Client) HasCapability(name string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.handshake.done {
		return false
	}
	_, ok := c.handshake.caps[name]
	return ok
}

// Capabilities returns a snapshot of negotiated capability names.
func (c *Client) Capabilities() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]string, 0, len(c.handshake.caps))
	for k := range c.handshake.caps {
		out = append(out, k)
	}
	return out
}

// Invoke sends an RPC to the guest, gated by capability. It returns
// ErrCapabilityUnavailable if requiredCapability is non-empty and the
// capability has not been negotiated. Invoke always ensures MethodHello has
// completed first; negotiation is cached per connection.
//
// Passing an empty requiredCapability bypasses gating — only MethodHello
// itself should do this, and that path goes through Negotiate.
func (c *Client) Invoke(ctx context.Context, method, requiredCapability string, params any, result any) error {
	if err := c.Negotiate(ctx); err != nil {
		return fmt.Errorf("guest %s: negotiate: %w", method, err)
	}

	if requiredCapability != "" && !c.HasCapability(requiredCapability) {
		return fmt.Errorf("%w: %s", ErrCapabilityUnavailable, requiredCapability)
	}

	req := Request{Method: method}
	if params != nil {
		req.Params = MarshalResult(params)
	}
	resp, err := c.roundTrip(ctx, req)
	if err != nil {
		return err
	}
	if resp.Error != "" || resp.ErrorCode != "" {
		if resp.ErrorCode == ErrorCodeUnknownMethod || resp.ErrorCode == ErrorCodeUnsupportedCapability {
			return fmt.Errorf("%w: %s", ErrCapabilityUnavailable, method)
		}
		return fmt.Errorf("guest %s: %s", method, resp.Error)
	}
	if result != nil && len(resp.Result) > 0 {
		if err := json.Unmarshal(resp.Result, result); err != nil {
			return fmt.Errorf("guest %s: decode result: %w", method, err)
		}
	}
	return nil
}

// Close closes the underlying transport.
func (c *Client) Close() error { return c.t.Close() }

func (c *Client) roundTrip(ctx context.Context, req Request) (*Response, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.broken {
		return nil, fmt.Errorf("guest transport is broken; reconnect required")
	}

	c.idSeq++
	req.ID = fmt.Sprintf("h-%d", c.idSeq)

	// Best-effort deadline on the transport if it's a net.Conn. Set and
	// cleared under c.mu so a concurrent call's deadline is never clobbered.
	if c.timeout > 0 {
		if conn, ok := c.t.(net.Conn); ok {
			deadline := time.Now().Add(c.timeout)
			if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
				deadline = d
			}
			_ = conn.SetDeadline(deadline)
			defer func() { _ = conn.SetDeadline(time.Time{}) }()
		}
	}

	if err := WriteMessage(c.t, &req); err != nil {
		c.poisonLocked()
		return nil, fmt.Errorf("write request: %w", err)
	}
	var resp Response
	if err := ReadMessage(c.t, &resp); err != nil {
		// A failed or timed-out read leaves an unconsumed (or partial)
		// response on the wire; every later call would desync. Poison the
		// transport so callers reconnect instead.
		c.poisonLocked()
		return nil, fmt.Errorf("read response: %w", err)
	}
	if resp.ID != req.ID {
		c.poisonLocked()
		return nil, fmt.Errorf("response id mismatch: got %q want %q", resp.ID, req.ID)
	}
	return &resp, nil
}

// poisonLocked marks the transport unusable and closes it. Callers must hold
// c.mu.
func (c *Client) poisonLocked() {
	c.broken = true
	_ = c.t.Close()
}

// isLegacyUnknownMethod detects the pre-0131 unknown-method signature.
//
// Keep this check as narrow as possible: new guests with structured
// ErrorCodeUnknownMethod match the explicit-code branch; everything else
// must match the exact "unknown method:" prefix produced by pre-0131
// handler.go so we never accidentally swallow an unrelated error.
//
// DELETION CRITERION: remove together with LegacyCapabilities.
func isLegacyUnknownMethod(resp *Response) bool {
	if resp.ErrorCode == ErrorCodeUnknownMethod {
		return true
	}
	if resp.ErrorCode != "" {
		// A new guest with a non-unknown structured code is not legacy.
		return false
	}
	return strings.HasPrefix(resp.Error, "unknown method:")
}

func setFromSlice(xs []string) map[string]struct{} {
	out := make(map[string]struct{}, len(xs))
	for _, x := range xs {
		out[x] = struct{}{}
	}
	return out
}
