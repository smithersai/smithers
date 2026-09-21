package cleanup

import (
	"context"
	"testing"
	"time"
)

// A non-positive cleanup interval (e.g. SMITHERS_CLEANUP_AUTH_INTERVAL=-5m or 0s,
// both of which time.ParseDuration accepts) must not crash the server at boot.
// Start builds the ticker synchronously and time.NewTicker panics on d<=0, so the
// constructor clamps a non-positive interval to its default.
func TestNewAuthCleaner_ClampsNonPositiveInterval(t *testing.T) {
	for _, interval := range []time.Duration{0, -5 * time.Minute, -1} {
		cleaner := NewAuthCleaner(&authCoverStore{}, interval)
		// Would panic ("non-positive interval for NewTicker") before the clamp.
		cleaner.Start(context.Background())
		cleaner.Stop()
	}
}
