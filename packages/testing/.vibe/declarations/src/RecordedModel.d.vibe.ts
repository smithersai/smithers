/**
 * A recorded, non-networking `ModelLike` implementation.
 *
 * @since 0.0.0
 */
import { Context, Effect, Layer } from "effect";
import { type Fixture, type RecordedCall } from "./Fixture.vibe";
import { type ModelLike as ModelLikeService } from "./ModelLike.vibe";
/**
 * Options for recorded-model replay.
 *
 * @category models
 * @since 0.0.0
 */
export interface Options {
    /** Require calls to be consumed in their fixture order. */
    readonly strictRequestOrder?: boolean | undefined;
}
/**
 * Controller for inspecting a recorded-model replay.
 *
 * @category services
 * @since 0.0.0
 */
export interface RecordedModel {
    /** Returns fixture calls that have not been selected for replay. */
    readonly unconsumed: () => Effect.Effect<ReadonlyArray<RecordedCall>>;
}
/**
 * The recorded-model controller service.
 *
 * @category services
 * @since 0.0.0
 */
export declare const RecordedModel: Context.Service<RecordedModel, RecordedModel>;
/**
 * The model and controller constructed from a fixture.
 *
 * @category models
 * @since 0.0.0
 */
export interface Replay {
    readonly model: ModelLikeService;
    readonly controller: RecordedModel;
}
/**
 * Builds a replay model and its controller. Calls are claimed before the
 * returned stream starts, so stream interruption leaves no pending claim or
 * background replay fiber. A request the fixture does not describe dies with
 * `UnscriptedModelError`, and a fixture recorded against another model dies
 * with `ReplayHarnessMismatchError`.
 *
 * @category constructors
 * @since 0.0.0
 */
export declare const make: (fixture: Fixture, options?: Options) => Effect.Effect<Replay>;
/**
 * Provides both `ModelLike` and the recorded-model controller.
 *
 * @category layers
 * @since 0.0.0
 */
export declare const layer: (fixture: Fixture, options?: Options) => Layer.Layer<ModelLikeService | RecordedModel>;
/**
 * Creates a fixture-backed model from handwritten calls.
 *
 * @category constructors
 * @since 0.0.0
 */
export declare const scripted: (...calls: ReadonlyArray<RecordedCall>) => Effect.Effect<Replay>;
