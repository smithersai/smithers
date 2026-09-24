package cleanup

import (
	"context"
	"time"
)

// Periodic runs deployment cleanup with the same lifecycle, failure metrics,
// and panic containment as product cleanup.
type Periodic struct{ runner periodicRunner }

func NewPeriodic(name string, interval, fallback time.Duration) *Periodic {
	r := &Periodic{}
	r.runner.init(name, interval, fallback)
	return r
}

func (r *Periodic) Start(ctx context.Context, sweep func(context.Context) error) {
	r.runner.start(ctx, sweep)
}
func (r *Periodic) Stop()                   { r.runner.Stop() }
func (r *Periodic) Wait()                   { r.runner.Wait() }
func (r *Periodic) Interval() time.Duration { return r.runner.interval }
