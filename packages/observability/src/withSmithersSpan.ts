import {
  TracingService,
  withSmithersSpan as withCoreSmithersSpan,
} from "@smithers/core/observability";
import { Effect } from "effect";
import type * as Tracer from "effect/Tracer";

export function withSmithersSpan<A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
  attributes?: Readonly<Record<string, unknown>>,
  _options?: Omit<Tracer.SpanOptions, "attributes" | "kind"> & {
    readonly kind?: Tracer.SpanKind;
  },
): Effect.Effect<A, E, Exclude<R, Tracer.ParentSpan>> {
  return Effect.flatMap(Effect.serviceOption(TracingService), (service) =>
    service._tag === "Some"
      ? service.value.withSpan(
          name,
          effect,
          attributes ? { ...attributes } : undefined,
        )
      : withCoreSmithersSpan(name, effect, attributes),
  ) as Effect.Effect<A, E, Exclude<R, Tracer.ParentSpan>>;
}
