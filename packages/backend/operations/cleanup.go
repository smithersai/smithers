package operations

import (
	"github.com/smithersai/smithers/packages/backend/internal/cleanup"
	"time"
)

type Periodic = cleanup.Periodic

func NewPeriodic(name string, interval, fallback time.Duration) *Periodic {
	return cleanup.NewPeriodic(name, interval, fallback)
}
