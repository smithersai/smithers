package runner

import (
	"encoding/json"
	"time"
)

const defaultHeartbeatTimeout = 60 * time.Second

type Config struct {
	HeartbeatTimeout time.Duration
}

type RegisterRunnerInput struct {
	Name     string
	Metadata json.RawMessage
}

type RunnerPool struct {
	store            Store
	heartbeatTimeout time.Duration
	now              func() time.Time
}

// NOTE: RUNNER-002 intentionally focuses on runner lifecycle + task queueing.
// Warm-pool sizing/orchestration (pool_size, warm_timeout, task_timeout) is
// tracked for follow-up runner-manager integration work.
func NewRunnerPool(store Store, cfg Config) *RunnerPool {
	timeout := cfg.HeartbeatTimeout
	if timeout <= 0 {
		timeout = defaultHeartbeatTimeout
	}

	return &RunnerPool{
		store:            store,
		heartbeatTimeout: timeout,
		now:              time.Now,
	}
}
