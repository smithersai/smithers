import * as BunContext from "@effect/platform-bun/BunContext";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import * as Otlp from "@effect/opentelemetry/Otlp";
import { Context, Effect, Layer, Logger, LogLevel } from "effect";
import {
  activeNodes,
  activeRuns,
  approvalsDenied,
  approvalsGranted,
  approvalsRequested,
  attemptDuration,
  cacheHits,
  cacheMisses,
  dbQueryDuration,
  dbRetries,
  hotReloadDuration,
  hotReloadFailures,
  hotReloads,
  httpRequestDuration,
  httpRequests,
  nodeDuration,
  nodesFailed,
  nodesFinished,
  nodesStarted,
  runsTotal,
  schedulerQueueDepth,
  toolCallsTotal,
  toolDuration,
  trackEvent,
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
};

export {
  activeNodes,
  activeRuns,
  approvalsDenied,
  approvalsGranted,
  approvalsRequested,
  attemptDuration,
  cacheHits,
  cacheMisses,
  dbQueryDuration,
  dbRetries,
  hotReloadDuration,
  hotReloadFailures,
  hotReloads,
  httpRequestDuration,
  httpRequests,
  nodeDuration,
  nodesFailed,
  nodesFinished,
  nodesStarted,
  runsTotal,
  schedulerQueueDepth,
  toolCallsTotal,
  toolDuration,
  trackEvent as trackSmithersEvent,
  vcsDuration,
};
