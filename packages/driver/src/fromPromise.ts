import { Effect } from "effect";
import type { ErrorWrapOptions, SmithersError } from "@smithers/errors";
import { toError } from "./toError.ts";

export function fromPromise<A>(
  label: string,
  evaluate: () => PromiseLike<A>,
  options: ErrorWrapOptions = {},
): Effect.Effect<A, SmithersError> {
  return Effect.tryPromise({
    try: () => evaluate(),
    catch: (cause) => toError(cause, label, options),
  });
}
