import * as WorkflowEngine from "@effect/workflow/WorkflowEngine";
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { SchedulerLive, WorkflowSessionLive } from "@smithers/scheduler";
import { CorrelationContextLive, MetricsServiceLive, TracingServiceLive, createSmithersRuntimeLayer, getCurrentSmithersTraceAnnotations, getCurrentSmithersTraceSpan, } from "@smithers/observability";
import { toSmithersError } from "@smithers/errors/toSmithersError";
const ObservabilityLayer = Layer.mergeAll(CorrelationContextLive, MetricsServiceLive, TracingServiceLive);
const SmithersCoreLayer = Layer.mergeAll(ObservabilityLayer, SchedulerLive.pipe(Layer.provide(ObservabilityLayer)), WorkflowSessionLive);
const SmithersWorkflowEngineLayer = Layer.suspend(() => WorkflowEngine.layerMemory);
const SmithersRuntimeLayer = Layer.mergeAll(SmithersCoreLayer, SmithersWorkflowEngineLayer, createSmithersRuntimeLayer()).pipe(Layer.orDie);
const runtime = ManagedRuntime.make(SmithersRuntimeLayer);
/**
 * @template A, E, R
 * @param {Effect.Effect<A, E, R>} effect
 */
function decorate(effect) {
    let program = effect.pipe(Effect.annotateLogs("service", "smithers"), Effect.withTracerEnabled(true));
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
/**
 * @param {unknown} cause
 * @returns {SmithersError}
 */
function normalizeRejection(cause) {
    return toSmithersError(cause);
}
/**
 * @template A, E, R
 * @param {Effect.Effect<A, E, R>} effect
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function runPromise(effect, options) {
    const exit = await runtime.runPromiseExit(decorate(effect), options);
    if (Exit.isSuccess(exit)) {
        return exit.value;
    }
    const failure = Cause.failureOption(exit.cause);
    if (failure._tag === "Some") {
        throw normalizeRejection(failure.value);
    }
    throw normalizeRejection(Cause.squash(exit.cause));
}
/**
 * @template A, E, R
 * @param {Effect.Effect<A, E, R>} effect
 */
export function runFork(effect) {
    return runtime.runFork(decorate(effect));
}
/**
 * @template A, E, R
 * @param {Effect.Effect<A, E, R>} effect
 */
export function runSync(effect) {
    return runtime.runSync(decorate(effect));
}
