/**
 * The configuration failures of the atomic filesystem helper: a layer option
 * outside its bounds, a request that cannot be serialized, and a helper that
 * cannot be found, is not usable, or is not trusted. A caller classifies one
 * by `_tag` and `code` instead of reading its message.
 * @since 1.0.0
 */
import { Schema } from "effect";
/**
 * Why the atomic helper could not be configured or resolved.
 * @category models
 * @since 1.0.0
 */
export declare const AtomicHelperErrorCode: Schema.Literals<readonly ["limit_invalid", "concurrency_invalid", "timeout_invalid", "request_not_serializable", "helper_missing", "helper_unusable", "helper_path_invalid", "helper_not_regular_file", "helper_inside_workspace", "staging_directory_not_private", "staging_unavailable"]>;
/**
 * The stable code of an {@link AtomicHelperError}.
 * @category models
 * @since 1.0.0
 */
export type AtomicHelperErrorCode = typeof AtomicHelperErrorCode.Type;
declare const AtomicHelperError_base: Schema.Class<AtomicHelperError, Schema.TaggedStruct<"@smthrs/platform-node/AtomicHelperError", {
    readonly code: Schema.Literals<readonly ["limit_invalid", "concurrency_invalid", "timeout_invalid", "request_not_serializable", "helper_missing", "helper_unusable", "helper_path_invalid", "helper_not_regular_file", "helper_inside_workspace", "staging_directory_not_private", "staging_unavailable"]>;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * The atomic helper is misconfigured, missing, or untrusted. `message` names
 * what was searched and how to install the helper where that applies.
 * @category errors
 * @since 1.0.0
 */
export declare class AtomicHelperError extends AtomicHelperError_base {
    readonly name = "AtomicHelperError";
}
export {};
