import { Effect, Metric, MetricState, Option } from "effect";
import {
  smithersMetricCatalog,
  toPrometheusMetricName,
  updateProcessMetrics,
  type SmithersMetricDefinition,
} from "./metrics";

type PrometheusMetricType = "counter" | "gauge" | "histogram" | "summary";

function escapePrometheusText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function escapePrometheusLabelValue(value: string): string {
  return escapePrometheusText(value).replace(/"/g, '\\"');
}

function formatPrometheusNumber(value: number | bigint): string {
  if (typeof value === "bigint") return value.toString();
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  return String(value);
}

function formatPrometheusLabels(labels: ReadonlyArray<[string, string]>): string {
  if (labels.length === 0) return "";
  return `{${labels
    .map(
      ([key, value]) =>
        `${toPrometheusMetricName(key)}="${escapePrometheusLabelValue(value)}"`,
    )
    .join(",")}}`;
}

function mergePrometheusLabels(
  base: ReadonlyArray<[string, string]>,
  extra: ReadonlyArray<[string, string]>,
): string {
  const merged = [...base, ...extra].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return formatPrometheusLabels(merged);
}

function metricLabels(metricKey: any): ReadonlyArray<[string, string]> {
  const tags: any[] = Array.isArray(metricKey?.tags) ? metricKey.tags : [];
  return tags
    .map((tag: any) => [String(tag.key), String(tag.value)] as [string, string])
    .sort(
      ([left]: [string, string], [right]: [string, string]) =>
        left.localeCompare(right),
    );
}

function metricHelp(metricKey: any): string | undefined {
  const description = Option.getOrElse(
    metricKey?.description as Option.Option<string>,
    () => "",
  );
  return description.trim() ? description : undefined;
}

type PrometheusBucket = {
  boundary: number;
  count: number | bigint;
};

function histogramBuckets(metricState: any): PrometheusBucket[] {
  const buckets: PrometheusBucket[] = [];
  if (
    !metricState?.buckets ||
    typeof metricState.buckets[Symbol.iterator] !== "function"
  ) {
    return buckets;
  }
  for (const [boundary, count] of metricState.buckets as Iterable<
    readonly [number, number | bigint]
  >) {
    buckets.push({ boundary, count });
  }
  return buckets.sort((left, right) => left.boundary - right.boundary);
}

type PrometheusMetricRecord = {
  type: PrometheusMetricType;
  help?: string;
  lines: string[];
};

function defaultMetricHelp(definition: SmithersMetricDefinition): string | undefined {
  return definition.description ?? definition.label;
}

function defaultPrometheusMetricLines(
  definition: SmithersMetricDefinition,
): string[] {
  const labelSets =
    definition.defaultLabels && definition.defaultLabels.length > 0
      ? definition.defaultLabels.map((labels) => Object.entries(labels))
      : [[]];

  if (definition.type === "histogram") {
    const boundaries = definition.boundaries ?? [];
    return labelSets.flatMap((labelSet) => {
      const baseLabels = labelSet as ReadonlyArray<[string, string]>;
      return [
        ...boundaries.map(
          (boundary) =>
            `${definition.prometheusName}_bucket${mergePrometheusLabels(baseLabels, [["le", String(boundary)]])} 0`,
        ),
        `${definition.prometheusName}_bucket${mergePrometheusLabels(baseLabels, [["le", "+Inf"]])} 0`,
        `${definition.prometheusName}_sum${formatPrometheusLabels(baseLabels)} 0`,
        `${definition.prometheusName}_count${formatPrometheusLabels(baseLabels)} 0`,
      ];
    });
  }

  return labelSets.map(
    (labelSet) =>
      `${definition.prometheusName}${formatPrometheusLabels(labelSet as ReadonlyArray<[string, string]>)} 0`,
  );
}

function registerPrometheusMetric(
  registry: Map<string, PrometheusMetricRecord>,
  name: string,
  type: PrometheusMetricType,
  help: string | undefined,
) {
  const existing = registry.get(name);
  if (existing) {
    if (!existing.help && help) {
      existing.help = help;
    }
    return existing;
  }
  const created = { type, help, lines: [] };
  registry.set(name, created);
  return created;
}

export function renderPrometheusMetrics(): string {
  // Snapshot process-level gauges before rendering
  try { Effect.runSync(updateProcessMetrics()); } catch { /* non-critical */ }

  const registry = new Map<
    string,
    PrometheusMetricRecord
  >();

  for (const snapshot of Metric.unsafeSnapshot()) {
    const metricKey = snapshot.metricKey as any;
    const metricState = snapshot.metricState as any;
    const name = toPrometheusMetricName(String(metricKey.name ?? ""));
    if (!name) continue;

    const labels = metricLabels(metricKey);
    const help = metricHelp(metricKey);

    if (MetricState.isCounterState(metricState)) {
      const metric = registerPrometheusMetric(registry, name, "counter", help);
      metric.lines.push(
        `${name}${formatPrometheusLabels(labels)} ${formatPrometheusNumber(metricState.count)}`,
      );
      continue;
    }

    if (MetricState.isGaugeState(metricState)) {
      const metric = registerPrometheusMetric(registry, name, "gauge", help);
      metric.lines.push(
        `${name}${formatPrometheusLabels(labels)} ${formatPrometheusNumber(metricState.value)}`,
      );
      continue;
    }

    if (MetricState.isHistogramState(metricState)) {
      const metric = registerPrometheusMetric(registry, name, "histogram", help);
      for (const bucket of histogramBuckets(metricState)) {
        metric.lines.push(
          `${name}_bucket${mergePrometheusLabels(labels, [["le", String(bucket.boundary)]])} ${formatPrometheusNumber(bucket.count)}`,
        );
      }
      metric.lines.push(
        `${name}_bucket${mergePrometheusLabels(labels, [["le", "+Inf"]])} ${formatPrometheusNumber(metricState.count)}`,
      );
      metric.lines.push(
        `${name}_sum${formatPrometheusLabels(labels)} ${formatPrometheusNumber(metricState.sum)}`,
      );
      metric.lines.push(
        `${name}_count${formatPrometheusLabels(labels)} ${formatPrometheusNumber(metricState.count)}`,
      );
      continue;
    }

    if (MetricState.isFrequencyState(metricState)) {
      const metric = registerPrometheusMetric(registry, name, "counter", help);
      for (const [key, count] of metricState.occurrences as Map<
        string,
        number | bigint
      >) {
        metric.lines.push(
        `${name}${mergePrometheusLabels(labels, [["key", key]])} ${formatPrometheusNumber(count)}`,
        );
      }
      continue;
    }

    if (MetricState.isSummaryState(metricState)) {
      const metric = registerPrometheusMetric(registry, name, "summary", help);
      metric.lines.push(
        `${name}${mergePrometheusLabels(labels, [["quantile", "min"]])} ${formatPrometheusNumber(metricState.min)}`,
      );
      for (const [quantile, value] of metricState.quantiles as ReadonlyArray<
        readonly [number, Option.Option<number>]
      >) {
        metric.lines.push(
          `${name}${mergePrometheusLabels(labels, [["quantile", String(quantile)]])} ${formatPrometheusNumber(Option.getOrElse(value, () => 0))}`,
        );
      }
      metric.lines.push(
        `${name}${mergePrometheusLabels(labels, [["quantile", "max"]])} ${formatPrometheusNumber(metricState.max)}`,
      );
      metric.lines.push(
        `${name}_sum${formatPrometheusLabels(labels)} ${formatPrometheusNumber(metricState.sum)}`,
      );
      metric.lines.push(
        `${name}_count${formatPrometheusLabels(labels)} ${formatPrometheusNumber(metricState.count)}`,
      );
    }
  }

  for (const definition of smithersMetricCatalog) {
    const metric = registerPrometheusMetric(
      registry,
      definition.prometheusName,
      definition.type,
      defaultMetricHelp(definition),
    );
    if (metric.lines.length === 0) {
      metric.lines.push(...defaultPrometheusMetricLines(definition));
    }
  }

  const lines: string[] = [];
  for (const [name, metric] of [...registry.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (metric.help) {
      lines.push(`# HELP ${name} ${escapePrometheusText(metric.help)}`);
    }
    lines.push(`# TYPE ${name} ${metric.type}`);
    lines.push(...metric.lines);
  }
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}
