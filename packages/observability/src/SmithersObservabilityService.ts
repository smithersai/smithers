import type { Effect } from "effect";
import type * as Tracer from "effect/Tracer";
import type { ResolvedSmithersObservabilityOptions } from "./ResolvedSmithersObservabilityOptions";

export type SmithersObservabilityService = {
  readonly options: ResolvedSmithersObservabilityOptions;
  readonly annotate: (
    attributes: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<void>;
  readonly withSpan: <A, E, R>(
    name: string,
    effect: Effect.Effect<A, E, R>,
    attributes?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<A, E, Exclude<R, Tracer.ParentSpan>>;
};
