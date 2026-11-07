/**
 * `EngineSubject` adapter over the real `/engine`.
 *
 * This is the authoritative subject for the core conformance operations:
 * identity, replay, race, and interruption run against the production engine,
 * not a test-only model. Governing design:
 * `packages/testing/docs/concepts/engine-subject.md`. Smithers capabilities absent from the production
 * contract are recorded as parity gaps rather than simulated. The adapter
 * registers each `FlowSpec` as a real `Flow` whose execute function
 * runs every step as an `Action`:
 *
 * - Sealed steps declare their spec key as the activity idempotency key, so
 *   the engine derives content identity from it and aliased sealed steps
 *   replay one recorded result.
 * - Unsealed steps declare no idempotency key, so the engine derives
 *   occurrence (ordinal) identity and duplicate declared keys run separately.
 * - Race steps run through `Action.raceAll`, the engine's durable race.
 *
 * Step outcomes are journaled by the adapter as they settle; replayed steps
 * never invoke their closures, so the journal is written exactly once per
 * behavior-bearing outcome.
 *
 * @since 0.0.0
 */
import { Crypto } from "@smthrs/crypto";
import { FlowRuntime } from "@smthrs/flow";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { type EngineSubject as EngineSubjectService } from "./EngineSubject.vibe";
/**
 * Constructs an `EngineSubject` over the real flow engine in the ambient
 * `FlowEngine` service.
 *
 * Each `run` registers the spec's flow (scoped to the construction
 * scope), starts the execution with `discard`, and then polls the engine
 * until the execution settles as completed, aborted, failed, or suspended.
 *
 * `interrupt` uses the engine's cooperative `FlowRuntime.interrupt`, which
 * delivers the interruption to the live body fiber. It is the durable engine's
 * only cancellation path: the release policy requires
 * `interruptUnsafe` to fail there with `unsafe_interrupt_unsupported`, so an
 * adapter built on it could not run a single interrupt pin against the engine
 * that ships.
 *
 * @category constructors
 * @since 0.0.0
 */
export declare const make: () => Effect.Effect<EngineSubjectService, never, Scope.Scope | FlowRuntime.FlowRuntime | Crypto.Crypto>;
/**
 * Provides an `EngineSubject` over the ambient `FlowEngine` service.
 *
 * @category layers
 * @since 0.0.0
 */
export declare const layer: () => Layer.Layer<EngineSubjectService, never, FlowRuntime.FlowRuntime | Crypto.Crypto>;
/**
 * Provides an `EngineSubject` over any `FlowRuntime` implementation.
 *
 * This is the seam the conformance suite binds to. `make` reads the runtime
 * out of the ambient service and never names an implementation, so the same
 * case list runs against whichever runtime is provided here: the volatile
 * `FlowEngine.layerMemory` below, or the durable engine, whose runtime layer
 * is `EngineStore.layer({ owner, journalSource })` in `@smthrs/engine-store`.
 * That package is not a dependency of this one, so the durable binding belongs
 * to a suite that already has it; supplying its layer is the whole connection.
 *
 * @category layers
 * @since 0.0.0
 */
export declare const layerOver: <E, R>(runtime: Layer.Layer<FlowRuntime.FlowRuntime, E, R>) => Layer.Layer<EngineSubjectService | Crypto.Crypto, E, R>;
/**
 * Provides an `EngineSubject` over the engine's in-memory implementation.
 *
 * @category layers
 * @since 0.0.0
 */
export declare const layerMemory: Layer.Layer<EngineSubjectService | Crypto.Crypto>;
