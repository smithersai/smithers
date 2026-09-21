package runner

import "context"

// Heartbeat updates the last heartbeat timestamp for a runner.
func (p *RunnerPool) Heartbeat(ctx context.Context, runnerID int64) error {
	return p.heartbeatRunner(ctx, runnerID)
}

func (p *RunnerPool) heartbeatRunner(ctx context.Context, runnerID int64) error {
	_, err := p.store.TouchRunnerHeartbeat(ctx, runnerID)
	return err
}
