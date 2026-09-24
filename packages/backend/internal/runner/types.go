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

// NewRunnerPool tracks runner lifecycle and task queueing. It has no warm-pool
// sizing; the task timeout lives in the executor configuration.
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
