package database

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestTracer_Cover_NegativeDurationSkipsObservation verifies that when the
// recorded start time is in the future (yielding a negative elapsed duration,
// e.g. from clock adjustment), TraceQueryEnd returns early without recording an
// observation. Because the test lives in-package, it can inject the private
// context keys directly.
func TestTracer_Cover_NegativeDurationSkipsObservation(t *testing.T) {
	t.Parallel()

	metrics := &dbQueryMetricsStub{}
	tracer := NewMetricsTracer(metrics)

	// Start time one hour in the future -> time.Since(start) < 0.
	ctx := context.WithValue(context.Background(), queryStartTimeKey{}, time.Now().Add(time.Hour))
	ctx = context.WithValue(ctx, queryLabelKey{}, "SELECT")

	require.NotPanics(t, func() {
		tracer.TraceQueryEnd(ctx, nil, pgx.TraceQueryEndData{})
	})

	assert.Equal(t, 0, metrics.count(),
		"negative-duration query must not record an observation")
}

// TestTracer_Cover_EmptyLabelDefaultsToOther verifies that when a start time
// is present but the label is missing/empty in the context, TraceQueryEnd
// records the observation under the bounded "OTHER" label.
func TestTracer_Cover_EmptyLabelDefaultsToOther(t *testing.T) {
	t.Parallel()

	metrics := &dbQueryMetricsStub{}
	tracer := NewMetricsTracer(metrics)

	// Real (past) start time, but explicitly empty label.
	ctx := context.WithValue(context.Background(), queryStartTimeKey{}, time.Now().Add(-time.Millisecond))
	ctx = context.WithValue(ctx, queryLabelKey{}, "")

	tracer.TraceQueryEnd(ctx, nil, pgx.TraceQueryEndData{})

	require.Equal(t, 1, metrics.count())
	assert.True(t, metrics.containsQuery(queryLabelOther),
		"missing label must default to the bounded OTHER label")
}
