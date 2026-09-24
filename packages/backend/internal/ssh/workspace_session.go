package ssh

import (
	"context"
	"net"
	"time"

	gliderssh "github.com/gliderlabs/ssh"
)

// workspaceDeadlineConn sits under gliderlabs' serverConn, which re-applies
// the server-wide idle/max deadline on every read and write through
// SetDeadline. Git connections keep exactly that policy. Once the context
// carries an authenticated workspace session, the 2h git lifetime cap no
// longer applies: the connection lives until the idle deadline (kept fresh by
// server keepalives) or the workspace lifetime cap, whichever is first.
type workspaceDeadlineConn struct {
	net.Conn
	ctx         gliderssh.Context
	idleTimeout time.Duration
	// maxDeadline is the absolute workspace lifetime; zero means unlimited.
	maxDeadline time.Time
}

func (c *workspaceDeadlineConn) SetDeadline(t time.Time) error {
	if _, workspace := c.ctx.Value(workspaceAccessKey).(WorkspaceAccess); !workspace || t.IsZero() {
		return c.Conn.SetDeadline(t)
	}
	return c.Conn.SetDeadline(c.workspaceDeadline(time.Now()))
}

// workspaceDeadline is the deadline a workspace connection gets on activity
// at now.
func (c *workspaceDeadlineConn) workspaceDeadline(now time.Time) time.Time {
	deadline := now.Add(c.idleTimeout)
	if !c.maxDeadline.IsZero() && c.maxDeadline.Before(deadline) {
		return c.maxDeadline
	}
	return deadline
}

// keepaliveSender is the *gossh.ServerConn surface the keepalive uses.
type KeepaliveSender interface {
	SendRequest(name string, wantReply bool, payload []byte) (bool, []byte, error)
}

// startWorkspaceKeepalive sends keepalive@openssh.com global requests every
// interval until stop is called or ctx ends. Each request is a write on the
// connection, which resets the idle deadline, so a workspace command that
// prints nothing for an hour is not reaped as an idle client. It returns the
// stop function.
func startWorkspaceKeepalive(ctx context.Context, sender KeepaliveSender, interval time.Duration) func() {
	ctx, cancel := context.WithCancel(ctx)
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if _, _, err := sender.SendRequest("keepalive@openssh.com", true, nil); err != nil {
					return
				}
			}
		}
	}()
	return cancel
}

// StartKeepalive maintains an authenticated forwarded SSH hop.
func StartKeepalive(ctx context.Context, sender KeepaliveSender) func() {
	return startWorkspaceKeepalive(ctx, sender, workspaceKeepaliveInterval)
}
