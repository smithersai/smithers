// Tests for the active-connection / subscription cap helper added in
// ticket 0132. Covers: under-cap acquire, at-cap reject, release
// decrements, unauth (userID == 0) bypass, multi-user isolation, and
// Prometheus counter / gauge emission.
package middleware

import (
	"sync"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestActiveCounter(t *testing.T, scope string, max int) (*ActiveCounter, *prometheus.CounterVec, *prometheus.GaugeVec) {
	t.Helper()
	reg := prometheus.NewRegistry()
	rej := prometheus.NewCounterVec(prometheus.CounterOpts{Name: "rej", Help: "h"}, []string{"scope"})
	g := prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "g", Help: "h"}, []string{"user_id"})
	reg.MustRegister(rej, g)
	ac := NewActiveCounter(scope, max, &ActiveCounterMetrics{Rejections: rej, Gauge: g})
	return ac, rej, g
}

func TestActiveCounter_AcquireUnderCap(t *testing.T) {
	t.Parallel()
	ac, _, g := newTestActiveCounter(t, "test", 3)

	assert.True(t, ac.Acquire(42))
	assert.True(t, ac.Acquire(42))
	assert.Equal(t, 2, ac.Count(42))
	assert.Equal(t, float64(2), testutil.ToFloat64(g.WithLabelValues("42")))
}

func TestActiveCounter_AtCapRejects(t *testing.T) {
	t.Parallel()
	ac, rej, _ := newTestActiveCounter(t, "test_scope", 2)

	require.True(t, ac.Acquire(7))
	require.True(t, ac.Acquire(7))
	assert.False(t, ac.Acquire(7), "third acquire at cap=2 must reject")
	assert.Equal(t, 2, ac.Count(7))

	// Rejection counter incremented with scope label.
	assert.Equal(t, float64(1), testutil.ToFloat64(rej.WithLabelValues("test_scope")))
}

func TestActiveCounter_ReleaseDecrements(t *testing.T) {
	t.Parallel()
	ac, _, g := newTestActiveCounter(t, "test", 2)

	require.True(t, ac.Acquire(1))
	require.True(t, ac.Acquire(1))
	assert.False(t, ac.Acquire(1))

	ac.Release(1)
	// After release, another acquire succeeds.
	assert.True(t, ac.Acquire(1))
	assert.Equal(t, 2, ac.Count(1))

	ac.Release(1)
	ac.Release(1)
	assert.Equal(t, 0, ac.Count(1))
	// Gauge label should be cleaned up when count hits zero.
	assert.Equal(t, float64(0), testutil.ToFloat64(g.WithLabelValues("1")))
}

func TestActiveCounter_MultiUserIsolation(t *testing.T) {
	t.Parallel()
	ac, rej, _ := newTestActiveCounter(t, "test", 1)

	require.True(t, ac.Acquire(1))
	// User 1 is saturated.
	assert.False(t, ac.Acquire(1))
	// User 2 must not be affected.
	assert.True(t, ac.Acquire(2))
	assert.Equal(t, 1, ac.Count(1))
	assert.Equal(t, 1, ac.Count(2))
	assert.Equal(t, float64(1), testutil.ToFloat64(rej.WithLabelValues("test")))
}

func TestActiveCounter_UnauthUserIDZeroAlwaysSucceeds(t *testing.T) {
	t.Parallel()
	ac, _, _ := newTestActiveCounter(t, "test", 1)

	assert.True(t, ac.Acquire(0))
	assert.True(t, ac.Acquire(0))
	// Releases are no-ops for userID 0.
	ac.Release(0)
}

func TestActiveCounter_MaxLTEZeroDisablesCap(t *testing.T) {
	t.Parallel()
	ac, rej, _ := newTestActiveCounter(t, "test", 0)

	for i := 0; i < 100; i++ {
		assert.True(t, ac.Acquire(9))
	}
	assert.Equal(t, float64(0), testutil.ToFloat64(rej.WithLabelValues("test")))
}

func TestActiveCounter_ReleaseUnderflowSafe(t *testing.T) {
	t.Parallel()
	ac, _, _ := newTestActiveCounter(t, "test", 2)

	// Release without Acquire is a no-op.
	ac.Release(5)
	ac.Release(5)
	assert.Equal(t, 0, ac.Count(5))
}

func TestActiveCounter_ConcurrentAcquireRelease(t *testing.T) {
	t.Parallel()
	ac, _, _ := newTestActiveCounter(t, "test", 10)

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if ac.Acquire(100) {
				ac.Release(100)
			}
		}()
	}
	wg.Wait()
	assert.Equal(t, 0, ac.Count(100), "all acquires must be balanced by releases")
}

func TestActiveCounter_NilSafe(t *testing.T) {
	t.Parallel()
	var ac *ActiveCounter
	assert.True(t, ac.Acquire(1))
	ac.Release(1) // must not panic
	assert.Equal(t, 0, ac.Count(1))
	assert.Equal(t, 0, ac.Max())
}
