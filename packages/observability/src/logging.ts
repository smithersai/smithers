import { Effect } from "effect";
import { runFork } from "@smithers/runtime/runtime";
import { getCurrentSmithersTraceAnnotations } from "./getCurrentSmithersTraceAnnotations";
import {
  correlationContextToLogAnnotations,
  getCurrentCorrelationContext,
  withCurrentCorrelationContext,
} from "./correlation";

type LogAnnotations = Record<string, unknown> | undefined;

function emitLog(
  effect: Effect.Effect<void, never, never>,
  annotations?: LogAnnotations,
  span?: string,
) {
  const correlationAnnotations = correlationContextToLogAnnotations(
    getCurrentCorrelationContext(),
  );
  const traceAnnotations = getCurrentSmithersTraceAnnotations();
  const mergedAnnotations =
    correlationAnnotations || traceAnnotations || annotations
      ? {
          ...correlationAnnotations,
          ...traceAnnotations,
          ...annotations,
        }
      : undefined;
  let program = effect;
  if (mergedAnnotations) {
    program = program.pipe(Effect.annotateLogs(mergedAnnotations));
  }
  if (span) {
    program = program.pipe(Effect.withLogSpan(span));
  }
  void runFork(withCurrentCorrelationContext(program));
}

export function logDebug(
  message: string,
  annotations?: LogAnnotations,
  span?: string,
) {
  emitLog(Effect.logDebug(message), annotations, span);
}

export function logInfo(
  message: string,
  annotations?: LogAnnotations,
  span?: string,
) {
  emitLog(Effect.logInfo(message), annotations, span);
}

export function logWarning(
  message: string,
  annotations?: LogAnnotations,
  span?: string,
) {
  emitLog(Effect.logWarning(message), annotations, span);
}

export function logError(
  message: string,
  annotations?: LogAnnotations,
  span?: string,
) {
  emitLog(Effect.logError(message), annotations, span);
}
