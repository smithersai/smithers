import type { Effect } from "effect";
import type { CorrelationPatch } from "./_coreCorrelation/CorrelationPatch.ts";

export type SmithersSpanAttributesInput = Readonly<Record<string, unknown>>;

export type TracingServiceShape = {
  readonly withSpan: <A, E, R>(
    name: string,
    effect: Effect.Effect<A, E, R>,
    attributes?: Record<string, unknown>,
  ) => Effect.Effect<A, E, R>;
  readonly annotate: (attributes: Record<string, unknown>) => Effect.Effect<void>;
  readonly withCorrelation: <A, E, R>(
    context: CorrelationPatch,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
};
