import { Effect } from "effect";
import type { ErrorWrapOptions, SmithersError } from "@smithers/errors";
import { toError } from "./toError.ts";

export function fromSync<A>(
  label: string,
  evaluate: () => A,
  options: ErrorWrapOptions = {},
): Effect.Effect<A, SmithersError> {
  return Effect.try({
    try: () => evaluate(),
    catch: (cause) => toError(cause, label, options),
  });
}
