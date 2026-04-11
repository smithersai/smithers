import { Effect, FiberRef } from "effect";
import type { CorrelationContext } from "./CorrelationContext.ts";
import { correlationContextFiberRef } from "./correlationContextFiberRef.ts";
import { correlationStorage } from "./_correlationStorage.ts";

export function getCurrentCorrelationContextEffect(): Effect.Effect<
  CorrelationContext | undefined
> {
  return FiberRef.get(correlationContextFiberRef).pipe(
    Effect.map((fiberContext) => fiberContext ?? correlationStorage.getStore()),
  );
}
