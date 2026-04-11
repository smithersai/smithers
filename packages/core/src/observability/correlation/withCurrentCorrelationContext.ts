import { Effect } from "effect";
import { correlationContextFiberRef } from "./correlationContextFiberRef.ts";
import { correlationStorage } from "./_correlationStorage.ts";

export function withCurrentCorrelationContext<A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  const current = correlationStorage.getStore();
  return current
    ? effect.pipe(Effect.locally(correlationContextFiberRef, current))
    : effect;
}
