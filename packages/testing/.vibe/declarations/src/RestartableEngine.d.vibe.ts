/**
 * Scoped restart harness for the reference in-memory engine.
 *
 * @since 0.0.0
 */
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import { type EngineSubject as EngineSubjectService, type ExecutionResult } from "./EngineSubject.vibe";
import type { EngineSubjectError, EngineUnavailableError } from "../../../src/TestingError.ts";
/**
 * A stable engine facade and controls for replacing its live in-memory
 * instance while retaining the persistent execution store.
 *
 * @category models
 * @since 0.0.0
 */
export interface Restartable {
    readonly engine: EngineSubjectService;
    readonly restart: Effect.Effect<void, EngineUnavailableError>;
    /**
     * Replaces the live instance WITHOUT closing the one it replaces.
     *
     * The difference from {@link restart} is the release. A restart closes the
     * outgoing instance's scope, so its fibers are interrupted and its
     * finalizers run — the orderly shutdown a process performs when it is asked
     * to stop. A kill runs neither: the abandoned instance keeps whatever it
     * held, exactly as SIGKILL leaves a durable owner holding a run it will
     * never release, which is the state lease-based reclaim has to recover from
     * (`Ownership.leaseLiveness`).
     *
     * The abandoned scope is still closed when the harness's own scope closes,
     * so a killed instance leaks nothing past the test that killed it.
     */
    readonly kill: Effect.Effect<void, EngineUnavailableError>;
    /**
     * {@link restart}, then `resume` on the fresh instance: the orderly
     * shutdown-and-restart a process performs when it is asked to stop.
     *
     * This is what `killAndResume` used to do under a name that promised the
     * opposite, so every restart-flavoured conformance run exercised the orderly
     * path and the hard-kill state no case ever reached.
     */
    readonly restartAndResume: (executionId: string) => Effect.Effect<ExecutionResult, EngineSubjectError>;
    /**
     * {@link kill}, then `resume` on the fresh instance while the killed one is
     * still running and unreleased. This is the state a lease-based reclaim
     * recovers from, and the only variant that produces it.
     */
    readonly killAndResume: (executionId: string) => Effect.Effect<ExecutionResult, EngineSubjectError>;
}
/**
 * Constructs a restartable engine over one persistent `MemoryEngine` store.
 *
 * `restart` closes the current instance scope, interrupting all of its live
 * execution fibers, and then constructs a fresh engine over the same store.
 * `kill` builds the same fresh engine but leaves the outgoing one running and
 * unreleased, which is the hard-kill state a lease-based reclaim recovers
 * from. The exposed engine is a stable facade that always delegates to the
 * current instance.
 *
 * @category constructors
 * @since 0.0.0
 */
export declare const make: () => Effect.Effect<Restartable, EngineUnavailableError, Scope.Scope>;
