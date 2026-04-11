import { Cause, Effect, Exit } from "effect";
import { toSmithersError } from "../errors.ts";
import { makeSmithersRuntime } from "./makeSmithersRuntime.ts";

const runtime = makeSmithersRuntime();

function decorate<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(
    Effect.annotateLogs("service", "smithers-core"),
    Effect.withTracerEnabled(true),
  );
}

function normalizeRejection(cause: unknown) {
  return toSmithersError(cause);
}

export async function runPromise<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options?: { readonly signal?: AbortSignal },
) {
  const exit = await runtime.runPromiseExit(
    decorate(effect) as Effect.Effect<A, E, never>,
    options,
  );
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "Some") {
    throw normalizeRejection(failure.value);
  }
  throw normalizeRejection(Cause.squash(exit.cause));
}
