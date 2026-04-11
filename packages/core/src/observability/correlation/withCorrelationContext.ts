import { Effect } from "effect";
import type { CorrelationPatch } from "./CorrelationPatch.ts";
import { correlationContextFiberRef } from "./correlationContextFiberRef.ts";
import { correlationStorage } from "./_correlationStorage.ts";
import { mergeCorrelationContext } from "./mergeCorrelationContext.ts";

export function withCorrelationContext<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  patch: CorrelationPatch,
) {
  const next = mergeCorrelationContext(correlationStorage.getStore(), patch);
  return next ? effect.pipe(Effect.locally(correlationContextFiberRef, next)) : effect;
}
