import * as BunContext from "@effect/platform-bun/BunContext";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import * as Otlp from "@effect/opentelemetry/Otlp";
import {
  MetricsService,
  TracingService,
  TracingServiceLive,
  annotateSmithersTrace as annotateCoreSmithersTrace,
  withSmithersSpan as withCoreSmithersSpan,
} from "@smithers/core/observability";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  Context,
  Effect,
  Layer,
  Logger,
  LogLevel,
  Metric,
  MetricState,
  Option,
} from "effect";
import type * as Tracer from "effect/Tracer";
import {
  activeNodes,
  activeRuns,
  approvalPending,
  externalWaitAsyncPending,
  approvalsDenied,
  approvalsGranted,
  approvalsRequested,
  approvalWaitDuration,
  timerDelayDuration,
  timersCancelled,
  timersCreated,
  timersFired,
  timersPending,
  attemptDuration,
  cacheHits,
  cacheMisses,
  dbQueryDuration,
  dbRetries,
  dbTransactionDuration,
  dbTransactionRetries,
  dbTransactionRollbacks,
  errorsTotal,
  eventsEmittedTotal,
  hotReloadDuration,
  hotReloadFailures,
  hotReloads,
  httpRequestDuration,
  httpRequests,
  nodeDuration,
  nodeRetriesTotal,
  nodesFailed,
  nodesFinished,
  nodesStarted,
  processHeapUsedBytes,
  processMemoryRssBytes,
  processUptimeSeconds,
  promptSizeBytes,
  responseSizeBytes,
  runDuration,
  runsAncestryDepth,
  runsCarriedStateBytes,
  runsCancelledTotal,
  runsContinuedTotal,
  runsFailedTotal,
  runsFinishedTotal,
  runsResumedTotal,
  sandboxActive,
  sandboxBundleSizeBytes,
  sandboxCompletedTotal,
  sandboxCreatedTotal,
  sandboxDurationMs,
  sandboxPatchCount,
  sandboxTransportDurationMs,
  runsTotal,
  schedulerConcurrencyUtilization,
  schedulerQueueDepth,
  schedulerWaitDuration,
  tokensCacheReadTotal,
  tokensCacheWriteTotal,
  tokensContextWindowBucketTotal,
  tokensContextWindowPerCall,
  tokensInputPerCall,
  tokensInputTotal,
  tokensOutputPerCall,
  tokensOutputTotal,
  tokensReasoningTotal,
  smithersMetricCatalog,
  type SmithersMetricDefinition,
  toPrometheusMetricName,
  toolCallErrorsTotal,
  toolCallsTotal,
  toolDuration,
  toolOutputTruncatedTotal,
  scorerEventsStarted,
  scorerEventsFinished,
  scorerEventsFailed,
  metricsServiceAdapter,
  trackEvent,
  updateProcessMetrics,
  vcsDuration,
} from "./metrics";

export {
  MetricsService,
  TracingService,
  TracingServiceLive,
} from "@smithers/core/observability";
export type {
  MetricLabels,
  MetricsServiceShape,
  MetricsSnapshot,
} from "@smithers/core/observability";

export type SmithersLogFormat = "json" | "pretty" | "string" | "logfmt";

export type SmithersObservabilityOptions = {
  readonly enabled?: boolean;
  readonly endpoint?: string;
  readonly serviceName?: string;
  readonly logFormat?: SmithersLogFormat;
  readonly logLevel?: LogLevel.LogLevel | string;
};

export type ResolvedSmithersObservabilityOptions = {
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly serviceName: string;
  readonly logFormat: SmithersLogFormat;
  readonly logLevel: LogLevel.LogLevel;
};

export type SmithersObservabilityService = {
  readonly options: ResolvedSmithersObservabilityOptions;
  readonly annotate: (
    attributes: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<void>;
  readonly withSpan: <A, E, R>(
    name: string,
    effect: Effect.Effect<A, E, R>,
    attributes?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<A, E, Exclude<R, Tracer.ParentSpan>>;
};

export class SmithersObservability extends Context.Tag("SmithersObservability")<
  SmithersObservability,
  SmithersObservabilityService
>() {}

export const prometheusContentType =
  "text/plain; version=0.0.4; charset=utf-8";

export const smithersSpanNames = {
  run: "smithers.run",
  task: "smithers.task",
  agent: "smithers.agent",
  tool: "smithers.tool",
} as const;

type SmithersSpanAttributesInput = Readonly<Record<string, unknown>>;

type PrometheusMetricType = "counter" | "gauge" | "histogram" | "summary";

const smithersTraceSpanStorage = new AsyncLocalStorage<Tracer.AnySpan>();

const smithersSpanAttributeAliases: Record<string, string> = {
  runId: "smithers.run_id",
  run_id: "smithers.run_id",
  workflowName: "smithers.workflow_name",
  workflow_name: "smithers.workflow_name",
  nodeId: "smithers.node_id",
  node_id: "smithers.node_id",
  iteration: "smithers.iteration",
  attempt: "smithers.attempt",
  nodeLabel: "smithers.node_label",
  node_label: "smithers.node_label",
  toolName: "smithers.tool_name",
  tool_name: "smithers.tool_name",
  agent: "smithers.agent",
  model: "smithers.model",
  status: "smithers.status",
  waitReason: "smithers.wait_reason",
  wait_reason: "smithers.wait_reason",
};

export function getCurrentSmithersTraceSpan(): Tracer.AnySpan | undefined {
  return smithersTraceSpanStorage.getStore();
}

export function getCurrentSmithersTraceAnnotations():
  | Readonly<Record<string, string>>
  | undefined {
  const span = getCurrentSmithersTraceSpan();
  if (!span) {
    return undefined;
  }
  return {
    traceId: span.traceId,
    spanId: span.spanId,
  };
}

export function makeSmithersSpanAttributes(
  attributes: SmithersSpanAttributesInput = {},
): Record<string, unknown> {
  const spanAttributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) {
      continue;
    }
    const nextKey =
      key.startsWith("smithers.") ? key : (smithersSpanAttributeAliases[key] ?? key);
    spanAttributes[nextKey] = value;
  }
  return spanAttributes;
}

export function annotateSmithersTrace(
  attributes: SmithersSpanAttributesInput = {},
): Effect.Effect<void> {
  return Effect.flatMap(Effect.serviceOption(TracingService), (service) =>
    service._tag === "Some"
      ? service.value.annotate({ ...attributes })
      : annotateCoreSmithersTrace(attributes),
  );
}

export function withSmithersSpan<A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
  attributes?: SmithersSpanAttributesInput,
  _options?: Omit<Tracer.SpanOptions, "attributes" | "kind"> & {
    readonly kind?: Tracer.SpanKind;
  },
): Effect.Effect<A, E, Exclude<R, Tracer.ParentSpan>> {
  return Effect.flatMap(Effect.serviceOption(TracingService), (service) =>
    service._tag === "Some"
      ? service.value.withSpan(
          name,
          effect,
          attributes ? { ...attributes } : undefined,
        )
      : withCoreSmithersSpan(name, effect, attributes),
  ) as Effect.Effect<A, E, Exclude<R, Tracer.ParentSpan>>;
}

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

export const MetricsServiceLive = Layer.succeed(MetricsService, {
  ...metricsServiceAdapter,
  renderPrometheus: () => Effect.sync(renderPrometheusMetrics),
});

function resolveLogLevel(
  value: LogLevel.LogLevel | string | undefined,
): LogLevel.LogLevel {
  if (typeof value !== "string") {
    return value ?? LogLevel.Info;
  }
  switch (value.toLowerCase()) {
    case "none":
      return LogLevel.None;
    case "trace":
      return LogLevel.Trace;
    case "debug":
      return LogLevel.Debug;
    case "warning":
    case "warn":
      return LogLevel.Warning;
    case "error":
      return LogLevel.Error;
    case "fatal":
      return LogLevel.Fatal;
    case "all":
      return LogLevel.All;
    case "info":
    default:
      return LogLevel.Info;
  }
}

function resolveLogFormat(value: string | undefined): SmithersLogFormat {
  switch ((value ?? "").toLowerCase()) {
    case "json":
      return "json";
    case "pretty":
      return "pretty";
    case "string":
      return "string";
    case "logfmt":
    default:
      return "logfmt";
  }
}

function resolveLogger(format: SmithersLogFormat) {
  switch (format) {
    case "json":
      return Logger.withLeveledConsole(Logger.jsonLogger);
    case "pretty":
      return Logger.prettyLogger();
    case "string":
      return Logger.withLeveledConsole(Logger.stringLogger);
    case "logfmt":
    default:
      return Logger.withLeveledConsole(Logger.logfmtLogger);
  }
}

function resolveEnabled(value: boolean | undefined): boolean {
  if (typeof value === "boolean") return value;
  const env = (process.env.SMITHERS_OTEL_ENABLED ?? "").toLowerCase();
  return env === "1" || env === "true";
}

function makeService(
  options: ResolvedSmithersObservabilityOptions,
): SmithersObservabilityService {
  return {
    options,
    annotate: (attributes) => annotateSmithersTrace(attributes),
    withSpan: (name, effect, attributes) =>
      withSmithersSpan(name, effect, attributes),
  };
}

export function resolveSmithersObservabilityOptions(
  options: SmithersObservabilityOptions = {},
): ResolvedSmithersObservabilityOptions {
  return {
    enabled: resolveEnabled(options.enabled),
    endpoint:
      options.endpoint ??
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
      "http://localhost:4318",
    serviceName:
      options.serviceName ?? process.env.OTEL_SERVICE_NAME ?? "smithers",
    logFormat: options.logFormat
      ? resolveLogFormat(options.logFormat)
      : resolveLogFormat(process.env.SMITHERS_LOG_FORMAT),
    logLevel: resolveLogLevel(
      options.logLevel ?? process.env.SMITHERS_LOG_LEVEL,
    ),
  };
}

export function createSmithersOtelLayer(
  options: SmithersObservabilityOptions = {},
) {
  const resolved = resolveSmithersObservabilityOptions(options);
  if (!resolved.enabled) {
    return Layer.empty;
  }
  return Otlp.layerJson({
    baseUrl: resolved.endpoint,
    resource: { serviceName: resolved.serviceName },
    tracerContext: (execute, span) => smithersTraceSpanStorage.run(span, execute),
  }).pipe(Layer.provide(FetchHttpClient.layer));
}

export function createSmithersObservabilityLayer(
  options: SmithersObservabilityOptions = {},
) {
  const resolved = resolveSmithersObservabilityOptions(options);
  return Layer.mergeAll(
    BunContext.layer,
    Logger.replace(Logger.defaultLogger, resolveLogger(resolved.logFormat)),
    Logger.minimumLogLevel(resolved.logLevel),
    createSmithersOtelLayer(resolved),
    MetricsServiceLive,
    TracingServiceLive,
    Layer.succeed(SmithersObservability, makeService(resolved)),
  );
}

export const createSmithersRuntimeLayer = createSmithersObservabilityLayer;

export const smithersMetrics = Object.fromEntries(
  smithersMetricCatalog.map((metric) => [metric.key, metric.metric] as const),
);

export {
  activeNodes,
  activeRuns,
  approvalPending,
  externalWaitAsyncPending,
  approvalsDenied,
  approvalsGranted,
  approvalsRequested,
  approvalWaitDuration,
  timerDelayDuration,
  timersCancelled,
  timersCreated,
  timersFired,
  timersPending,
  attemptDuration,
  cacheHits,
  cacheMisses,
  dbQueryDuration,
  dbRetries,
  dbTransactionDuration,
  dbTransactionRetries,
  dbTransactionRollbacks,
  errorsTotal,
  eventsEmittedTotal,
  hotReloadDuration,
  hotReloadFailures,
  hotReloads,
  httpRequestDuration,
  httpRequests,
  nodeDuration,
  nodeRetriesTotal,
  nodesFailed,
  nodesFinished,
  nodesStarted,
  processHeapUsedBytes,
  processMemoryRssBytes,
  processUptimeSeconds,
  promptSizeBytes,
  responseSizeBytes,
  runDuration,
  runsCancelledTotal,
  runsContinuedTotal,
  runsFailedTotal,
  runsFinishedTotal,
  runsResumedTotal,
  runsAncestryDepth,
  runsCarriedStateBytes,
  sandboxActive,
  sandboxBundleSizeBytes,
  sandboxCompletedTotal,
  sandboxCreatedTotal,
  sandboxDurationMs,
  sandboxPatchCount,
  sandboxTransportDurationMs,
  runsTotal,
  schedulerConcurrencyUtilization,
  schedulerQueueDepth,
  schedulerWaitDuration,
  tokensCacheReadTotal,
  tokensCacheWriteTotal,
  tokensContextWindowBucketTotal,
  tokensContextWindowPerCall,
  tokensInputPerCall,
  tokensInputTotal,
  tokensOutputPerCall,
  tokensOutputTotal,
  tokensReasoningTotal,
  toolCallErrorsTotal,
  toolCallsTotal,
  toolDuration,
  toolOutputTruncatedTotal,
  scorerEventsStarted,
  scorerEventsFinished,
  scorerEventsFailed,
  trackEvent as trackSmithersEvent,
  updateProcessMetrics,
  vcsDuration,
};
