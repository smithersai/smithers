/**
 * The reasons a named Microsandbox machine is not reattached to.
 *
 * `openMachine` raises one inside its attempt, and the provider reports it as
 * the `cause` of a `ProviderError`, so a caller reads the stable `code`
 * instead of parsing the message.
 *
 * @since 1.0.0
 */
import * as Schema from "effect/Schema";
/**
 * Why a reattach was refused.
 *
 * @category models
 * @since 1.0.0
 */
export declare const MicrosandboxReattachRefusalCode: Schema.Literals<readonly ["network_mismatch", "limits_mismatch", "ownership_not_recorded"]>;
declare const MicrosandboxReattachRefusal_base: Schema.Class<MicrosandboxReattachRefusal, Schema.TaggedStruct<"@smthrs/sandbox/MicrosandboxReattachRefusal", {
    readonly code: Schema.Literals<readonly ["network_mismatch", "limits_mismatch", "ownership_not_recorded"]>;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * A machine that cannot be reattached to under this session's configuration.
 *
 * @category errors
 * @since 1.0.0
 */
export declare class MicrosandboxReattachRefusal extends MicrosandboxReattachRefusal_base {
    readonly name = "MicrosandboxReattachRefusal";
}
export {};
