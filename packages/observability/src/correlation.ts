import {
  getCurrentCorrelationContext as getCoreCurrentCorrelationContext,
  mergeCorrelationContext as mergeCoreCorrelationContext,
} from "@smithers/core/observability";
import type {
  CorrelationContext,
  CorrelationPatch,
} from "@smithers/core/observability";

export type {
  CorrelationContext,
  CorrelationPatch,
} from "@smithers/core/observability";

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
} from "@smithers/core/observability";

export type CorrelationContextPatch = CorrelationPatch;

export function updateCurrentCorrelationContext(
  patch: CorrelationPatch,
): void {
  const current = getCoreCurrentCorrelationContext();
  if (!current) return;

  // TODO: replace this compatibility shim once legacy callers adopt the
  // Effect-returning updateCurrentCorrelationContext from @smithers/core.
  const next = mergeCoreCorrelationContext(current, patch);
  if (!next) return;
  Object.assign(current, next satisfies CorrelationContext);
}
