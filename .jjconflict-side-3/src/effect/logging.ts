import { Effect } from "effect";
import { runFork } from "./runtime";

type LogAnnotations = Record<string, unknown> | undefined;

function emitLog(
  effect: Effect.Effect<void, never, never>,
  annotations?: LogAnnotations,
  span?: string,
) {
  let program = effect;
  if (annotations) {
    program = program.pipe(Effect.annotateLogs(annotations));
  }
  if (span) {
    program = program.pipe(Effect.withLogSpan(span));
  }
  void runFork(program);
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
