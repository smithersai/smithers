import * as BunContext from "@effect/platform-bun/BunContext";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import * as Otlp from "@effect/opentelemetry/Otlp";
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
  toolCallErrorsTotal,
  toolCallsTotal,
  toolDuration,
  toolOutputTruncatedTotal,
  scorerEventsStarted,
  scorerEventsFinished,
  scorerEventsFailed,
  trackEvent,
  updateProcessMetrics,
  vcsDuration,
} from "../effect/metrics";

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
  ) => Effect.Effect<A, E, R>;
};

export class SmithersObservability extends Context.Tag("SmithersObservability")<
  SmithersObservability,
  SmithersObservabilityService
>() {}

export const prometheusContentType =
  "text/plain; version=0.0.4; charset=utf-8";

type PrometheusMetricType = "counter" | "gauge" | "histogram" | "summary";

function sanitizePrometheusName(name: string): string {
  const next = name.replace(/[^a-zA-Z0-9_:]/g, "_");
  return /^[a-zA-Z_:]/.test(next) ? next : `_${next}`;
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
        `${sanitizePrometheusName(key)}="${escapePrometheusLabelValue(value)}"`,
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
  return buckets;
}

function registerPrometheusMetric(
  registry: Map<
    string,
    { type: PrometheusMetricType; help?: string; lines: string[] }
  >,
  name: string,
  type: PrometheusMetricType,
  help: string | undefined,
) {
  const existing = registry.get(name);
  if (existing) return existing;
  const created = { type, help, lines: [] };
  registry.set(name, created);
  return created;
}

export function renderPrometheusMetrics(): string {
  // Snapshot process-level gauges before rendering
  try { Effect.runSync(updateProcessMetrics()); } catch { /* non-critical */ }

  const registry = new Map<
    string,
    { type: PrometheusMetricType; help?: string; lines: string[] }
  >();

  for (const snapshot of Metric.unsafeSnapshot()) {
    const metricKey = snapshot.metricKey as any;
    const metricState = snapshot.metricState as any;
    const name = sanitizePrometheusName(String(metricKey.name ?? ""));
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

  const lines: string[] = [];
  for (const [name, metric] of [...registry.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (metric.help) {
      lines.push(`# HELP ${name} ${escapePrometheusText(metric.help)}`);
    }
    lines.push(`# TYPE ${name} ${metric.type}`);
    lines.push(...metric.lines.sort((left, right) => left.localeCompare(right)));
  }
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

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
    annotate: (attributes) => Effect.void.pipe(Effect.annotateLogs(attributes)),
    withSpan: (name, effect, attributes) =>
      (attributes && Object.keys(attributes).length > 0
        ? effect.pipe(Effect.annotateLogs(attributes))
        : effect
      ).pipe(Effect.withLogSpan(name)),
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
    Layer.succeed(SmithersObservability, makeService(resolved)),
  );
}

export const createSmithersRuntimeLayer = createSmithersObservabilityLayer;

export const smithersMetrics = {
  // existing
  runsTotal,
  activeRuns,
  nodesStarted,
  nodesFinished,
  nodesFailed,
  activeNodes,
  nodeDuration,
  attemptDuration,
  toolCallsTotal,
  toolDuration,
  cacheHits,
  cacheMisses,
  dbQueryDuration,
  dbRetries,
  dbTransactionDuration,
  dbTransactionRetries,
  dbTransactionRollbacks,
  schedulerQueueDepth,
  hotReloads,
  hotReloadFailures,
  hotReloadDuration,
  httpRequests,
  httpRequestDuration,
  approvalsRequested,
  approvalsGranted,
  approvalsDenied,
  vcsDuration,
  // token usage
  tokensInputTotal,
  tokensOutputTotal,
  tokensCacheReadTotal,
  tokensCacheWriteTotal,
  tokensContextWindowBucketTotal,
  tokensReasoningTotal,
  tokensInputPerCall,
  tokensOutputPerCall,
  tokensContextWindowPerCall,
  // run lifecycle
  runsFinishedTotal,
  runsFailedTotal,
  runsCancelledTotal,
  runsResumedTotal,
  runsContinuedTotal,
  runDuration,
  runsAncestryDepth,
  runsCarriedStateBytes,
  // sandboxes
  sandboxCreatedTotal,
  sandboxCompletedTotal,
  sandboxActive,
  sandboxDurationMs,
  sandboxBundleSizeBytes,
  sandboxTransportDurationMs,
  sandboxPatchCount,
  // errors & retries
  errorsTotal,
  nodeRetriesTotal,
  toolCallErrorsTotal,
  toolOutputTruncatedTotal,
  // prompt & response sizes
  promptSizeBytes,
  responseSizeBytes,
  // approvals
  approvalPending,
  externalWaitAsyncPending,
  approvalWaitDuration,
  // timers
  timersCreated,
  timersFired,
  timersCancelled,
  timersPending,
  timerDelayDuration,
  // scheduler
  schedulerConcurrencyUtilization,
  schedulerWaitDuration,
  // events
  eventsEmittedTotal,
  // process
  processUptimeSeconds,
  processMemoryRssBytes,
  processHeapUsedBytes,
  // scorers
  scorerEventsStarted,
  scorerEventsFinished,
  scorerEventsFailed,
};

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
