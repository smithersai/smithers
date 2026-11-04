/**
 * Hold a model turn until the test releases it.
 *
 * An ordering or timing test needs a run to stop at one exact model turn: a
 * TODO held in Working while another one lands, a pause requested while a plan
 * is in flight. A replayed model answers at once, so the test needs a gate in
 * front of it. `TurnGate.model` wraps any `/model/Model`; a turn whose request
 * names a key waits until `release(key)`, and every other turn passes through.
 *
 * A release is sticky. Every turn held on the key is answered, and every later
 * turn on the same key passes at once, so a test never races the run to the
 * gate.
 *
 * @since 1.0.0
 */
import * as Model from "@smthrs/model/Model";
import type { ModelRequest } from "@smthrs/model/ModelRequest";
import { Effect } from "effect";
/**
 * The hold-and-release controller a test drives.
 *
 * @category models
 * @since 1.0.0
 */
export interface TurnGate {
    /** Waits until `key` is released; returns at once when it already was. */
    readonly hold: (key: string) => Effect.Effect<void>;
    /** Answers every turn held on `key`, and every later one at once. */
    readonly release: (key: string) => Effect.Effect<void>;
    /** The keys turns wait on now, one entry per waiting turn, in arrival order. */
    readonly held: () => Effect.Effect<ReadonlyArray<string>>;
}
/**
 * Builds a gate with nothing held and nothing released.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const make: () => Effect.Effect<TurnGate>;
/**
 * What {@link model} is built from.
 *
 * @category models
 * @since 1.0.0
 */
export interface ModelOptions {
    readonly gate: TurnGate;
    /** The key a turn waits on, or `undefined` for a turn that is never held. */
    readonly key: (request: ModelRequest) => string | undefined;
}
/**
 * Wraps a model so a turn whose request names a key waits on the gate before
 * the wrapped model is called.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const model: (inner: Model.Model, options: ModelOptions) => Model.Model;
