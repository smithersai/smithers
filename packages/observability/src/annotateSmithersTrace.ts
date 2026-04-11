import {
  TracingService,
  annotateSmithersTrace as annotateCoreSmithersTrace,
} from "@smithers/core/observability";
import { Effect } from "effect";

export function annotateSmithersTrace(
  attributes: Readonly<Record<string, unknown>> = {},
): Effect.Effect<void> {
  return Effect.flatMap(Effect.serviceOption(TracingService), (service) =>
    service._tag === "Some"
      ? service.value.annotate({ ...attributes })
      : annotateCoreSmithersTrace(attributes),
  );
}
