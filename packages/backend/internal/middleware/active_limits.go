// Package middleware — active-connection/subscription caps (ticket 0132).
//
// Companion to rate_limit.go. Where rate_limit.go covers OPEN-rate
// (DB-backed token buckets that survive restarts), this file covers
// concurrent ACTIVE counts for long-lived surfaces: terminal WebSockets
// and other long-lived authenticated connections.
//
// Implementation is process-local (sync.Mutex + map[int64]int). This is
// explicitly acceptable for v1 per the ticket:
//   - Terminal caps protect the local SSH dial path on the same process.
//   - Horizontal scale requires a shared counter or sticky sessions.
//
// Why mutex + map over sync.Map: the hot path is Acquire() which must
// do a compare-then-increment under the cap. sync.Map does not provide
// an atomic CAS against a current count, so we'd need a mutex anyway.
// A single sync.Mutex on a small map is simpler and measurably faster
// for the write-heavy pattern here (every Acquire/Release touches the
// map). Gauge emission reads a per-user count under the same lock.
package middleware

import (
	"sync"

	"github.com/prometheus/client_golang/prometheus"
)

// ActiveCounter tracks the number of currently active connections or
// subscriptions per authenticated user and enforces a hard cap.
//
// Zero value is NOT usable; construct with NewActiveCounter.
type ActiveCounter struct {
	// scope is a short identifier (for example, "workspace_terminal").
	// used purely for Prometheus label values and structured log fields.
	scope string

	// max is the per-user concurrent cap. A value <= 0 disables the cap
	// (every Acquire succeeds). This mirrors how the rate-limit helpers
	// treat non-positive limits.
	max int

	mu     sync.Mutex
	counts map[int64]int

	// Metrics (optional — nil is fine). Using CounterVec / GaugeVec with a
	// user_id label so operators can spot a hot user. High-cardinality label
	// is acceptable because the cap is small and per-user gauges only exist
	// while a user has active connections.
	rejections *prometheus.CounterVec
	gauge      *prometheus.GaugeVec
}

// ActiveCounterMetrics bundles the Prometheus collectors an ActiveCounter
// emits. Callers register these with their own registry.
type ActiveCounterMetrics struct {
	Rejections *prometheus.CounterVec
	Gauge      *prometheus.GaugeVec
}

// NewActiveCounter creates a counter for the given scope with the given cap.
// `max <= 0` disables enforcement (every Acquire succeeds). Metrics may be
// nil; in that case no Prometheus state is emitted.
func NewActiveCounter(scope string, max int, metrics *ActiveCounterMetrics) *ActiveCounter {
	ac := &ActiveCounter{
		scope:  scope,
		max:    max,
		counts: make(map[int64]int),
	}
	if metrics != nil {
		ac.rejections = metrics.Rejections
		ac.gauge = metrics.Gauge
	}
	return ac
}

// Acquire attempts to reserve a slot for userID. Returns true if the caller
// is under the cap (and the slot is now held); false if acquisition would
// exceed the cap, in which case the rejection counter is incremented and
// the caller must return HTTP 429 without doing any further work.
//
// userID == 0 is treated as "unauthenticated" and always succeeds — the
// authenticated middleware layer is responsible for preventing anonymous
// traffic from reaching these routes in the first place, so we avoid
// double-gating. (Tested explicitly.)
func (a *ActiveCounter) Acquire(userID int64) bool {
	if a == nil || a.max <= 0 || userID == 0 {
		return true
	}
	a.mu.Lock()
	defer a.mu.Unlock()

	current := a.counts[userID]
	if current >= a.max {
		if a.rejections != nil {
			a.rejections.WithLabelValues(a.scope).Inc()
		}
		return false
	}
	a.counts[userID] = current + 1
	if a.gauge != nil {
		a.gauge.WithLabelValues(activeLimitFormatUserID(userID)).Set(float64(current + 1))
	}
	return true
}

// Release decrements the active count for userID. Safe to call even if the
// matching Acquire returned false (no-op in that case, because we never
// incremented). Callers SHOULD defer Release immediately after a successful
// Acquire so it runs exactly once per acquisition.
func (a *ActiveCounter) Release(userID int64) {
	if a == nil || a.max <= 0 || userID == 0 {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()

	current, ok := a.counts[userID]
	if !ok || current <= 0 {
		return
	}
	current--
	if current == 0 {
		delete(a.counts, userID)
		if a.gauge != nil {
			// Clean up the per-user gauge label so /metrics doesn't grow
			// unboundedly across user IDs.
			a.gauge.DeleteLabelValues(activeLimitFormatUserID(userID))
		}
		return
	}
	a.counts[userID] = current
	if a.gauge != nil {
		a.gauge.WithLabelValues(activeLimitFormatUserID(userID)).Set(float64(current))
	}
}

// Count returns the current active count for userID (for tests + debugging).
func (a *ActiveCounter) Count(userID int64) int {
	if a == nil {
		return 0
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.counts[userID]
}

// Max returns the configured cap (for tests + logging).
func (a *ActiveCounter) Max() int {
	if a == nil {
		return 0
	}
	return a.max
}

// activeLimitFormatUserID renders a user ID as a Prometheus label value.
func activeLimitFormatUserID(id int64) string {
	// strconv would pull in another import for a one-liner; use a local
	// formatter that avoids allocating a strconv FormatInt round-trip
	// on the hot path. Simple base-10 encoding.
	if id == 0 {
		return "0"
	}
	negative := id < 0
	if negative {
		id = -id
	}
	var buf [20]byte
	i := len(buf)
	for id > 0 {
		i--
		buf[i] = byte('0' + id%10)
		id /= 10
	}
	if negative {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
