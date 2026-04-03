import { Metric, MetricBoundaries } from "effect";

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

export const snapshotsCaptured = Metric.counter("smithers.snapshots.captured");
export const runForksCreated = Metric.counter("smithers.forks.created");
export const replaysStarted = Metric.counter("smithers.replays.started");

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------

const snapshotBuckets = MetricBoundaries.exponential({
  start: 1,
  factor: 2,
  count: 12,
}); // ~1ms to ~2s

export const snapshotDuration = Metric.histogram(
  "smithers.snapshot.duration_ms",
  snapshotBuckets,
);
