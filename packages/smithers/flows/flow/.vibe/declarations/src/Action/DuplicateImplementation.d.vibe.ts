/**
 * Defines the `DuplicateImplementation` action failure.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema";
declare const DuplicateImplementation_base: Schema.Class<DuplicateImplementation, Schema.TaggedStruct<"@smthrs/flow/Action/DuplicateImplementation", {
    readonly name: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * Two implementations competed for one action tag without an explicit override.
 * @category errors
 * @since 0.1.0
 */
export declare class DuplicateImplementation extends DuplicateImplementation_base {
    /** @since 1.0.0 */
    get message(): string;
}
export {};
