import { Metric } from "effect";

export const ragIngestCount = Metric.counter("smithers.rag.ingest_total");
