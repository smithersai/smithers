import {
  getCurrentCorrelationContext as getCoreCurrentCorrelationContext,
  mergeCorrelationContext as mergeCoreCorrelationContext,
} from "./_coreCorrelation/index.ts";
import type {
  CorrelationContext,
  CorrelationPatch,
} from "./_coreCorrelation/index.ts";

export type {
  CorrelationContext,
  CorrelationPatch,
} from "./_coreCorrelation/index.ts";

export {
  correlationContextFiberRef,
  correlationContextToLogAnnotations,
  CorrelationContextLive,
  CorrelationContextService,
  getCurrentCorrelationContext,
  getCurrentCorrelationContextEffect,
  mergeCorrelationContext,
  runWithCorrelationContext,
  withCorrelationContext,
  withCurrentCorrelationContext,
} from "./_coreCorrelation/index.ts";

export type CorrelationContextPatch = CorrelationPatch;

export function updateCurrentCorrelationContext(
  patch: CorrelationPatch,
): void {
  const current = getCoreCurrentCorrelationContext();
  if (!current) return;

  // TODO: replace this compatibility shim once legacy callers adopt the
  // Effect-returning updateCurrentCorrelationContext from @smithers/observability.
  const next = mergeCoreCorrelationContext(current, patch);
  if (!next) return;
  Object.assign(current, next satisfies CorrelationContext);
}
