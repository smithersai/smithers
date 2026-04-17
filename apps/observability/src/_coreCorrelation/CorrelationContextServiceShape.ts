import type { Effect } from "effect";
import type { CorrelationContext } from "./CorrelationContext.ts";
import type { CorrelationPatch } from "./CorrelationPatch.ts";

export type CorrelationContextServiceShape = {
  readonly current: () => Effect.Effect<CorrelationContext | undefined>;
  readonly withCorrelation: <A, E, R>(
    patch: CorrelationPatch,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly toLogAnnotations: (
    context?: CorrelationContext | null,
  ) => Record<string, unknown> | undefined;
};
