/** Bounded paths for schema failures at durable boundaries.
 * @since 1.0.0
 */
import type * as Schema from "effect/Schema";
/**
 * Finds the first rejected field in an Effect schema error without rendering
 * the value stored at that field. Follows the first issue branch for at most
 * 64 wrappers, returning the accumulated path when the limit is reached.
 * Field names are caller-controlled and the returned text is not redacted
 * or length-limited.
 *
 * @param error - An Effect schema decode or encode failure.
 * @returns A JSON-style path beginning with $, or $ for a root rejection.
 *
 * @category formatting
 * @since 0.1.0
 */
export declare const firstPath: (error: Schema.SchemaError) => string;
