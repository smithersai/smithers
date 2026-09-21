package routes

import (
	"context"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

// relayConnRegistry tracks every upstream connection a gateway relay opened,
// keyed by gateway, so a revocation can close them. A relayed WebSocket is
// hijacked on both ends and never re-checks authorization; closing its
// upstream connection is the only way to end it, and the reverse proxy then
// closes the client side on its own.
type relayConnRegistry struct {
	mu          sync.Mutex
	conns       map[net.Conn]revocation.Principal
	unsubscribe func()
}

var relayConns = &relayConnRegistry{conns: map[net.Conn]revocation.Principal{}}

// rearm subscribes the registry to source, replacing any earlier subscription.
func (r *relayConnRegistry) rearm(source RevocationSource) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.unsubscribe != nil {
		r.unsubscribe()
		r.unsubscribe = nil
	}
	if source != nil {
		r.unsubscribe = source.Subscribe(r.handle)
	}
}

// handle closes every tracked connection the event revokes.
func (r *relayConnRegistry) handle(event revocation.Event) {
	r.mu.Lock()
	var doomed []net.Conn
	for conn, principal := range r.conns {
		if event.Affects(principal) {
			doomed = append(doomed, conn)
			delete(r.conns, conn)
		}
	}
	r.mu.Unlock()
	for _, conn := range doomed {
		_ = conn.Close()
	}
}

func (r *relayConnRegistry) track(conn net.Conn, principal revocation.Principal) net.Conn {
	tracked := &trackedConn{Conn: conn, registry: r}
	r.mu.Lock()
	r.conns[tracked] = principal
	r.mu.Unlock()
	return tracked
}

func (r *relayConnRegistry) forget(conn net.Conn) {
	r.mu.Lock()
	delete(r.conns, conn)
	r.mu.Unlock()
}

func (r *relayConnRegistry) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.conns)
}

// transport returns a RoundTripper whose dialed connections are tracked under
// principal for the life of each connection.
func (r *relayConnRegistry) transport(principal revocation.Principal) http.RoundTripper {
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	return &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			conn, err := dialer.DialContext(ctx, network, addr)
			if err != nil {
				return nil, err
			}
			return r.track(conn, principal), nil
		},
		// Every relay request dials fresh so a revocation closes exactly the
		// connections that carried that gateway's traffic.
		DisableKeepAlives:     true,
		ResponseHeaderTimeout: 60 * time.Second,
	}
}

type trackedConn struct {
	net.Conn
	registry *relayConnRegistry
	once     sync.Once
}

func (c *trackedConn) Close() error {
	c.once.Do(func() { c.registry.forget(c) })
	return c.Conn.Close()
}
