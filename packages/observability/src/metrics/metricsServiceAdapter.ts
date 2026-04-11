import {
  renderPrometheusSamples,
  type MetricLabels,
  type MetricsServiceShape,
  type MetricsSnapshot,
  type PrometheusSample,
} from "@smithers/core/observability";
import { Effect, Metric, MetricState } from "effect";
import type { SmithersEvent } from "@smithers/core/SmithersEvent";
import type { SmithersMetricDefinition } from "./SmithersMetricDefinition";
import { toPrometheusMetricName } from "./toPrometheusMetricName";
import { durationBuckets } from "./_buckets";
import { smithersMetricCatalogByName } from "./smithersMetricCatalogByName";
import { smithersMetricCatalogByPrometheusName } from "./smithersMetricCatalogByPrometheusName";
import { trackEvent } from "./trackEvent";
import { updateProcessMetrics } from "./updateProcessMetrics";
import { updateAsyncExternalWaitPending } from "./updateAsyncExternalWaitPending";

function resolveMetricDefinition(name: string): SmithersMetricDefinition | undefined {
  return (
    smithersMetricCatalogByName.get(name) ??
    smithersMetricCatalogByPrometheusName.get(toPrometheusMetricName(name))
  );
}

function tagMetricWithLabels<A extends Metric.Metric<any, any, any>>(
  metric: A,
  labels?: MetricLabels,
): A {
  let tagged: any = metric;
  for (const [key, value] of Object.entries(labels ?? {})) {
    tagged = Metric.tagged(tagged, key, String(value));
  }
  return tagged as A;
}

function counterOrGaugeMetric(
  name: string,
  labels?: MetricLabels,
): Metric.Metric<any, number, any> {
  const definition = resolveMetricDefinition(name);
  const metric =
    definition?.type === "counter" || definition?.type === "gauge"
      ? definition.metric
      : Metric.counter(name);
  return tagMetricWithLabels(metric as Metric.Metric<any, number, any>, labels);
}

function gaugeMetric(
  name: string,
  labels?: MetricLabels,
): Metric.Metric<any, number, any> {
  const definition = resolveMetricDefinition(name);
  const metric = definition?.type === "gauge" ? definition.metric : Metric.gauge(name);
  return tagMetricWithLabels(metric as Metric.Metric<any, number, any>, labels);
}

function histogramMetric(
  name: string,
  labels?: MetricLabels,
): Metric.Metric<any, number, any> {
  const definition = resolveMetricDefinition(name);
  const metric =
    definition?.type === "histogram"
      ? definition.metric
      : Metric.histogram(name, durationBuckets);
  return tagMetricWithLabels(metric as Metric.Metric<any, number, any>, labels);
}

function metricValueAsNumber(value: number | bigint | undefined): number {
  if (typeof value === "bigint") return Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function metricsServiceLabels(metricKey: any): MetricLabels {
  const tags: any[] = Array.isArray(metricKey?.tags) ? metricKey.tags : [];
  return Object.freeze(
    Object.fromEntries(
      tags
        .map((tag: any) => [String(tag.key), String(tag.value)] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

function metricsServiceLabelsKey(labels: MetricLabels): string {
  return JSON.stringify(
    Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function metricsServiceSnapshotKey(name: string, labels: MetricLabels): string {
  return `${name}|${metricsServiceLabelsKey(labels)}`;
}

function metricsServicePrometheusSamples(): PrometheusSample[] {
  const samples: PrometheusSample[] = [];
  for (const snapshot of Metric.unsafeSnapshot()) {
    const metricKey = snapshot.metricKey as any;
    const metricState = snapshot.metricState as any;
    const name = String(metricKey.name ?? "");
    if (!name) continue;

    const labels = metricsServiceLabels(metricKey);
    if (MetricState.isCounterState(metricState)) {
      samples.push({
        name,
        type: "counter",
        labels,
        value: metricValueAsNumber(metricState.count),
      });
      continue;
    }

    if (MetricState.isGaugeState(metricState)) {
      samples.push({
        name,
        type: "gauge",
        labels,
        value: metricValueAsNumber(metricState.value),
      });
      continue;
    }

    if (MetricState.isHistogramState(metricState)) {
      samples.push({
        name,
        type: "histogram",
        labels,
        buckets: new Map(
          [...metricState.buckets].map(([boundary, count]) => [
            boundary,
            metricValueAsNumber(count),
          ]),
        ),
        sum: metricValueAsNumber(metricState.sum),
        count: metricValueAsNumber(metricState.count),
      });
    }
  }
  return samples;
}

function metricsServiceSnapshot(): MetricsSnapshot {
  const result = new Map<string, any>();
  for (const sample of metricsServicePrometheusSamples()) {
    const key = metricsServiceSnapshotKey(sample.name, sample.labels);
    if (sample.type === "histogram") {
      result.set(key, {
        type: "histogram",
        sum: sample.sum ?? 0,
        count: sample.count ?? 0,
        labels: sample.labels,
        buckets: new Map(sample.buckets ?? []),
      });
      continue;
    }
    result.set(key, {
      type: sample.type,
      value: sample.value ?? 0,
      labels: sample.labels,
    });
  }
  return result as MetricsSnapshot;
}

export const metricsServiceAdapter: MetricsServiceShape = {
  increment: (name, labels) =>
    Metric.incrementBy(counterOrGaugeMetric(name, labels) as any, 1),
  incrementBy: (name, value, labels) =>
    Metric.incrementBy(counterOrGaugeMetric(name, labels) as any, value),
  gauge: (name, value, labels) => Metric.set(gaugeMetric(name, labels) as any, value),
  histogram: (name, value, labels) =>
    Metric.update(histogramMetric(name, labels), value),
  recordEvent: (event) => trackEvent(event as SmithersEvent),
  updateProcessMetrics: () => updateProcessMetrics(),
  updateAsyncExternalWaitPending: (kind, delta) =>
    updateAsyncExternalWaitPending(kind, delta),
  renderPrometheus: () =>
    Effect.sync(() => renderPrometheusSamples(metricsServicePrometheusSamples())),
  snapshot: () => Effect.sync(metricsServiceSnapshot),
} satisfies MetricsServiceShape;
