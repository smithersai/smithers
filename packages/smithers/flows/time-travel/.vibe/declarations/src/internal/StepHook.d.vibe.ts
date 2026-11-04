/**
 * The fault-injection hook fork and rewind run before each named step.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import { type TimeTravelError } from "../TimeTravelError.vibe";
/**
 * Runs `hook` for `step`, if there is one, reporting its failure as `unknown`
 * with `"<verb> failed at <step>"`.
 *
 * @since 0.1.0
 * @category combinators
 */
export declare const run: <Step extends string>(verb: string, hook: ((step: Step) => Effect.Effect<void, unknown>) | undefined, step: Step) => Effect.Effect<void, TimeTravelError>;
