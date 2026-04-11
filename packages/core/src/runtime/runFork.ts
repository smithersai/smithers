import { Effect } from "effect";
import { makeSmithersRuntime } from "./makeSmithersRuntime.ts";

const runtime = makeSmithersRuntime();

function decorate<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(
    Effect.annotateLogs("service", "smithers-core"),
    Effect.withTracerEnabled(true),
  );
}

export function runFork<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return runtime.runFork(decorate(effect) as Effect.Effect<A, E, never>);
}
