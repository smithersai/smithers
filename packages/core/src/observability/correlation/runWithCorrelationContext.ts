import type { CorrelationPatch } from "./CorrelationPatch.ts";
import { correlationStorage } from "./_correlationStorage.ts";
import { mergeCorrelationContext } from "./mergeCorrelationContext.ts";

export function runWithCorrelationContext<T>(
  patch: CorrelationPatch,
  fn: () => T,
): T {
  const next = mergeCorrelationContext(correlationStorage.getStore(), patch);
  return next ? correlationStorage.run(next, fn) : fn();
}
