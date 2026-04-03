import { Cause, Effect, Exit, ManagedRuntime } from "effect";
import { createSmithersRuntimeLayer } from "../observability";
import { type SmithersError, toSmithersError } from "../utils/errors";

const SmithersRuntimeLayer = createSmithersRuntimeLayer();

const runtime = ManagedRuntime.make(SmithersRuntimeLayer);

function decorate<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(Effect.annotateLogs("service", "smithers"));
}

function normalizeRejection(cause: unknown): SmithersError {
  return toSmithersError(cause);
}

export async function runPromise<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options?: { signal?: AbortSignal },
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

export function runFork<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return runtime.runFork(decorate(effect) as Effect.Effect<A, E, never>);
}

export function runSync<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return runtime.runSync(decorate(effect) as Effect.Effect<A, E, never>);
}

export { SmithersRuntimeLayer };
