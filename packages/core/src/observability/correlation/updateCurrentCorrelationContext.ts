import { Effect, FiberRef } from "effect";
import type { CorrelationContext } from "./CorrelationContext.ts";
import type { CorrelationPatch } from "./CorrelationPatch.ts";
import { correlationContextFiberRef } from "./correlationContextFiberRef.ts";
import { getCurrentCorrelationContextEffect } from "./getCurrentCorrelationContextEffect.ts";
import { mergeCorrelationContext } from "./mergeCorrelationContext.ts";

export function updateCurrentCorrelationContext(
  patch: CorrelationPatch,
): Effect.Effect<CorrelationContext | undefined> {
  return Effect.gen(function* () {
    const current = yield* getCurrentCorrelationContextEffect();
    const next = mergeCorrelationContext(current, patch);
    yield* FiberRef.set(correlationContextFiberRef, next);
    return next;
  });
}
