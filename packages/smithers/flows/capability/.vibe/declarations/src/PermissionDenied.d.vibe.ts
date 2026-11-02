/**
 * The refused-capability failure and its constructor.
 *
 * @since 0.1.0
 */
import { Schema } from "effect";
import { Capability } from "../../../src/Capability.ts";
declare const PermissionDenied_base: Schema.Class<PermissionDenied, Schema.TaggedStruct<"@smthrs/capability/PermissionDenied", {
    readonly code: Schema.Literal<"permission_denied">;
    readonly capability: typeof Capability;
    readonly reason: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * A capability rejected by policy or by the current capability ceiling. The
 * error retains a defensive copy rather than the caller's `Capability`
 * instance, and its `capability` slot is non-writable.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export declare class PermissionDenied extends PermissionDenied_base {
    constructor(props: {
        readonly code?: "permission_denied";
        readonly capability: Capability;
        readonly reason: string;
    });
}
/**
 * Constructs a denied permission failure.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const permissionDenied: (capability: Capability, reason: string) => PermissionDenied;
export {};
