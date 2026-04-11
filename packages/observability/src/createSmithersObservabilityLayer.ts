import * as BunContext from "@effect/platform-bun/BunContext";
import { TracingServiceLive } from "@smithers/core/observability";
import { Effect, Layer, Logger } from "effect";
import type { SmithersLogFormat } from "./SmithersLogFormat";
import { SmithersObservability } from "./SmithersObservability";
import type { SmithersObservabilityService } from "./SmithersObservabilityService";
import type { SmithersObservabilityOptions } from "./SmithersObservabilityOptions";
import type { ResolvedSmithersObservabilityOptions } from "./ResolvedSmithersObservabilityOptions";
import { resolveSmithersObservabilityOptions } from "./resolveSmithersObservabilityOptions";
import { createSmithersOtelLayer } from "./createSmithersOtelLayer";
import { MetricsServiceLive } from "./MetricsServiceLive";
import { annotateSmithersTrace } from "./annotateSmithersTrace";
import { withSmithersSpan } from "./withSmithersSpan";

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
