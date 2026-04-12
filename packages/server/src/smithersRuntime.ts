import * as WorkflowEngine from "@effect/workflow/WorkflowEngine";
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { DurablePrimitivesLive } from "@smithers/durables/DurablePrimitivesLive";
import { SchedulerLive, WorkflowSessionLive } from "@smithers/scheduler";
import {
  CorrelationContextLive,
  MetricsServiceLive,
  TracingServiceLive,
  createSmithersRuntimeLayer,
  getCurrentSmithersTraceAnnotations,
  getCurrentSmithersTraceSpan,
} from "@smithers/observability";
import { toSmithersError } from "@smithers/errors/toSmithersError";
import type { SmithersError } from "@smithers/errors/SmithersError";

const ObservabilityLayer = Layer.mergeAll(
  CorrelationContextLive,
  MetricsServiceLive,
  TracingServiceLive,
);

const SmithersCoreLayer = Layer.mergeAll(
  ObservabilityLayer,
  SchedulerLive.pipe(Layer.provide(ObservabilityLayer)),
  DurablePrimitivesLive,
  WorkflowSessionLive,
);

const SmithersWorkflowEngineLayer = Layer.suspend(() => WorkflowEngine.layerMemory);
const SmithersRuntimeLayer = Layer.mergeAll(
  SmithersCoreLayer,
  SmithersWorkflowEngineLayer,
  createSmithersRuntimeLayer(),
).pipe(Layer.orDie) as Layer.Layer<unknown, never, never>;

const runtime = ManagedRuntime.make(SmithersRuntimeLayer);

function decorate<A, E, R>(effect: Effect.Effect<A, E, R>) {
  let program = effect.pipe(
    Effect.annotateLogs("service", "smithers"),
    Effect.withTracerEnabled(true),
  );
  const traceAnnotations = getCurrentSmithersTraceAnnotations();
  if (traceAnnotations) {
    program = program.pipe(Effect.annotateLogs(traceAnnotations));
  }
  const parentSpan = getCurrentSmithersTraceSpan();
  if (parentSpan) {
    program = program.pipe(Effect.withParentSpan(parentSpan));
  }
  return program;
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
