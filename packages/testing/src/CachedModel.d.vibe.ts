/**
 * A model that answers from a fixture and records what the fixture is missing.
 *
 * This is the record-and-replay loop as one layer: a call whose canonical
 * request digest is already in the fixture replays from it, and a call that is
 * not runs against the live model and is appended. The first run records, every
 * run after it replays, and neither the test nor the flow changes shape.
 *
 * Without a live model it only replays: a miss dies with
 * `UnscriptedModelError` and never reaches the network, which is the mode a
 * CI run uses.
 *
 * @since 0.0.0
 */
import * as Model from "@smthrs/model/Model";
import { type Layer } from "effect";
import type { FixtureStore } from "./FixtureStore.ts";
import type { RecordedRequestLike } from "./ModelLike.ts";
/**
 * What a cached model is built from.
 *
 * @category models
 * @since 0.0.0
 */
export interface Options {
    /**
     * The model a cache miss runs against. Omit it to replay only: a miss then
     * dies with `UnscriptedModelError`, records nothing, and never reaches the
     * network.
     */
    readonly live?: Model.Model | undefined;
    /** The fixture the cache reads and records into. */
    readonly fixture: FixtureStore;
    /**
     * Rewrites what changes from run to run (a temporary path, a port, a run
     * id) out of a request before it is keyed and recorded, so the next run's
     * request finds the same recording. The live model still receives the
     * original request. Leave `modelId` alone.
     */
    readonly normalize?: ((request: RecordedRequestLike) => RecordedRequestLike) | undefined;
}
/**
 * Builds a model that replays a fixture hit and records a miss.
 *
 * The fixture is consulted per call rather than once, so a miss recorded by one
 * call is a hit for the next identical one inside the same run. Nothing is
 * claimed: a cache serves the same recording to every request that matches it,
 * which is what makes a retried step deterministic.
 *
 * @category constructors
 * @since 0.0.0
 */
export declare const make: (options: Options) => Model.Model;
/**
 * Provides {@link make} as the `/model/Model` seam.
 *
 * @category layers
 * @since 0.0.0
 */
export declare const layer: (options: Options) => Layer.Layer<Model.Model>;
