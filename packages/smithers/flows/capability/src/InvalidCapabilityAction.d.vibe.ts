/**
 * The failure of rendering a capability with an action outside the vocabulary.
 *
 * @since 0.1.0
 */
import { Schema } from "effect";
declare const InvalidCapabilityAction_base: Schema.Class<InvalidCapabilityAction, Schema.TaggedStruct<"@smthrs/capability/InvalidCapabilityAction", {
    readonly code: Schema.Literal<"invalid_capability_action">;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * An action outside the closed vocabulary was handed to {@link format}.
 * `code` is always `invalid_capability_action`.
 *
 * @since 0.1.0
 * @category errors
 */
export declare class InvalidCapabilityAction extends InvalidCapabilityAction_base {
}
export {};
