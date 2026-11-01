/**
 * Typed host connectivity failures, including failed command diagnostics.
 *
 * @since 1.0.0
 */
import * as Schema from "effect/Schema";
declare const Unreachable_base: Schema.Class<Unreachable, Schema.TaggedStruct<"@smthrs/kernel/Unreachable", {
    readonly message: Schema.String;
    readonly cause: Schema.optional<Schema.Unknown>;
}>, import("effect/Cause").YieldableError>;
/**
 * A temporarily unreachable resolver, connection, or HTTP service.
 *
 * @category errors
 * @since 1.0.0
 */
export declare class Unreachable extends Unreachable_base {
}
/**
 * Classifies stderr from a failed host command; other exits keep their domain error.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const classifyExit: (stderr: string) => Unreachable | undefined;
export {};
