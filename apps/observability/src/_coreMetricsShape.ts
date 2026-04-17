import type { Effect } from "effect";
import type { MetricLabels } from "./_corePrometheusShape.ts";
import type { MetricName } from "./MetricName.ts";

export type SmithersMetricEvent = {
  readonly type: string;
  readonly [key: string]: unknown;
};

export type CounterEntry = {
  readonly type: "counter";
  value: number;
  readonly labels: MetricLabels;
};

export type GaugeEntry = {
  readonly type: "gauge";
  value: number;
  readonly labels: MetricLabels;
};

export type HistogramEntry = {
  readonly type: "histogram";
  sum: number;
  count: number;
  readonly labels: MetricLabels;
  readonly buckets: Map<number, number>;
};

export type MetricEntry = CounterEntry | GaugeEntry | HistogramEntry;

export type MetricsSnapshot = ReadonlyMap<string, MetricEntry>;

export type MetricsServiceShape = {
  readonly increment: (name: MetricName, labels?: MetricLabels) => Effect.Effect<void>;
  readonly incrementBy: (
    name: MetricName,
    value: number,
    labels?: MetricLabels,
  ) => Effect.Effect<void>;
  readonly gauge: (name: MetricName, value: number, labels?: MetricLabels) => Effect.Effect<void>;
  readonly histogram: (
    name: MetricName,
    value: number,
    labels?: MetricLabels,
  ) => Effect.Effect<void>;
  readonly recordEvent: (event: SmithersMetricEvent) => Effect.Effect<void>;
  readonly updateProcessMetrics: () => Effect.Effect<void>;
  readonly updateAsyncExternalWaitPending: (
    kind: "approval" | "event",
    delta: number,
  ) => Effect.Effect<void>;
  readonly renderPrometheus: () => Effect.Effect<string>;
  readonly snapshot: () => Effect.Effect<MetricsSnapshot>;
};
