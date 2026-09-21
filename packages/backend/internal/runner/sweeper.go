package runner

import (
	"context"
	"log/slog"
	"time"
)

const defaultStaleSweepInterval = 30 * time.Second

// RunStaleSweeper continuously reaps runner rows whose heartbeat exceeded the
// pool timeout. It sweeps once at startup so a zombie from an earlier API
// process cannot hold the deploy lease gate until the first ticker interval.
func (p *RunnerPool) RunStaleSweeper(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = defaultStaleSweepInterval
	}

	sweep := func() {
		cleaned, err := p.CleanupStaleRunners(ctx)
		if err != nil {
			slog.Error("runner stale sweep failed", "error", err)
			return
		}
		if cleaned > 0 {
			slog.Warn("reaped stale runner leases", "count", cleaned, "heartbeat_timeout", p.heartbeatTimeout)
		}
	}

	sweep()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sweep()
		}
	}
}
