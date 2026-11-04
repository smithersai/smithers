/**
 * The model-backed author seat.
 *
 * Requires `Model.Model` from context — production supplies a route stack,
 * tests supply a replay model — and maps an author input onto the sealed
 * request shape of the harness's sealed steps: prefix as the stable system
 * part, context lines as one user message, no tools, `toolChoice: "none"`
 * (https://chain.smithers.sh/contract/). Prior art, copied rather than
 * imported: the sealed steps in
 * packages/smithers/agent/harness/src/CellTurn.ts.
 *
 * @since 0.1.0
 */
import * as Model from "@smthrs/model/Model";
import * as ModelRequest from "@smthrs/model/ModelRequest";
import { Effect, Layer } from "effect";
import * as Author from "./Author.vibe";
/**
 * Which model the seat calls, and the generation parameters it calls with.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Config {
    readonly modelId: string;
    readonly params?: ModelRequest.GenerationParams | undefined;
}
/**
 * The pure mapping from an author input to the wire-neutral request — the
 * same function derives test fixtures, so a mapping drift breaks the
 * replay match loudly instead of silently changing the step key.
 *
 * The prefix is host-supplied. `Prompt.assemble` places a fixed rule before
 * the catalog and encodes repository descriptions as labelled, untrusted
 * data; this mapping preserves that boundary in the system part.
 *
 * Degenerate inputs collapse to wire-valid shapes: an empty prefix emits
 * no system part at all, and an empty context (reachable from any script
 * via a garbage author payload) becomes one placeholder line — providers
 * reject empty system blocks and empty user content outright.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const requestFor: (config: Config) => (input: Author.Input) => ModelRequest.ModelRequest;
/**
 * Builds the author seat over the ambient model.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const make: (config: Config) => Effect.Effect<Author.Service, never, Model.Model>;
/**
 * The production author layer: `Author` from `Model.Model`.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export declare const layer: (config: Config) => Layer.Layer<Author.Author, never, Model.Model>;
