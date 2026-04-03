import { Metric, MetricBoundaries } from "effect";

// ---------------------------------------------------------------------------
// RAG counters
// ---------------------------------------------------------------------------

export const ragIngestCount = Metric.counter("smithers.rag.ingest_total");
export const ragRetrieveCount = Metric.counter("smithers.rag.retrieve_total");

// ---------------------------------------------------------------------------
// RAG histograms
// ---------------------------------------------------------------------------

const durationBuckets = MetricBoundaries.exponential({
  start: 10,
  factor: 2,
  count: 14,
}); // ~10ms to ~80s

export const ragRetrieveDuration = Metric.histogram(
  "smithers.rag.retrieve_duration_ms",
  durationBuckets,
);

export const ragEmbedDuration = Metric.histogram(
  "smithers.rag.embed_duration_ms",
  durationBuckets,
);
