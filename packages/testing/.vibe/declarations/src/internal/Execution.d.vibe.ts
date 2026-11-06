/**
 * The shared rule both reference engines apply when a `run` names an execution
 * id that already exists.
 *
 * Accepting the id and silently running the original flow on the original
 * payload gave a caller no signal that its arguments were ignored, on the seam
 * that defines engine conformance. Joining an identical re-submission is still
 * the intended behaviour: an idempotent retry must not fail.
 *
 * This module is internal: `./internal/*` is null-mapped in the export map and
 * carries no compatibility promise.
 *
 * @since 0.0.0
 */
import * as Option from "effect/Option";
import { ExecutionConflictError } from "../TestingError.vibe";
/**
 * What an existing execution was started with.
 *
 * @since 0.0.0
 * @category models
 */
export interface ExecutionConflict {
    readonly flowName: string;
    readonly payload: unknown;
}
/**
 * The conflict between an existing execution and a re-submission, if the two
 * disagree about the flow or the payload.
 *
 * @since 0.0.0
 * @category constructors
 */
export declare const conflict: (executionId: string, existing: ExecutionConflict, submitted: ExecutionConflict) => Option.Option<ExecutionConflictError>;
