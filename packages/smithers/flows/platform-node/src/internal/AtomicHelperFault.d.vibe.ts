/**
 * The atomic helper broke its protocol or its transport failed: a response that
 * is not framed, a field of the wrong shape, an answer over a bound, a helper
 * that never answered, or one that exited. `AtomicFileSystemProtocol.failure`
 * reports one as the `cause` of a `PlatformError`, so a caller classifies it by
 * `_tag` and `code`. {@link AtomicHelperRejection} carries the errno a helper
 * itself reported.
 * @since 1.0.0
 */
import { Schema } from "effect";
/**
 * Which rule of the helper protocol or transport was broken.
 * @category models
 * @since 1.0.0
 */
export declare const AtomicHelperFaultCode: Schema.Literals<readonly ["response_unframed", "response_tag_unknown", "response_length_invalid", "response_length_mismatch", "envelope_malformed", "field_malformed", "file_type_unknown", "payload_malformed", "read_limit_exceeded", "entries_malformed", "batch_malformed", "digest_malformed", "result_malformed", "operation_unsupported", "helper_timeout", "response_limit_exceeded", "helper_rejected", "helper_exited"]>;
/**
 * The stable code of an {@link AtomicHelperFault}.
 * @category models
 * @since 1.0.0
 */
export type AtomicHelperFaultCode = typeof AtomicHelperFaultCode.Type;
declare const AtomicHelperFault_base: Schema.Class<AtomicHelperFault, Schema.TaggedStruct<"@smthrs/platform-node/AtomicHelperFault", {
    readonly code: Schema.Literals<readonly ["response_unframed", "response_tag_unknown", "response_length_invalid", "response_length_mismatch", "envelope_malformed", "field_malformed", "file_type_unknown", "payload_malformed", "read_limit_exceeded", "entries_malformed", "batch_malformed", "digest_malformed", "result_malformed", "operation_unsupported", "helper_timeout", "response_limit_exceeded", "helper_rejected", "helper_exited"]>;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * The helper's response or process broke the protocol. The helper is treated as
 * untrusted, so the operation fails closed.
 * @category errors
 * @since 1.0.0
 */
export declare class AtomicHelperFault extends AtomicHelperFault_base {
    readonly name = "AtomicHelperFault";
}
/**
 * A helper fault with a stable code.
 * @category constructors
 * @since 1.0.0
 */
export declare const atomicHelperFault: (code: AtomicHelperFaultCode, message: string) => AtomicHelperFault;
declare const AtomicHelperRejection_base: Schema.Class<AtomicHelperRejection, Schema.TaggedStruct<"@smthrs/platform-node/AtomicHelperRejection", {
    readonly code: Schema.String;
    readonly syscall: Schema.optional<Schema.String>;
    readonly message: Schema.String;
    readonly cause: Schema.optional<Schema.Unknown>;
}>, import("effect/Cause").YieldableError>;
/**
 * The errno a helper reported for a syscall it ran, in the shape the native
 * Node adapter's errors carry so callers that read `code` and `syscall` see the
 * same contract.
 * @category errors
 * @since 1.0.0
 */
export declare class AtomicHelperRejection extends AtomicHelperRejection_base {
    readonly name = "AtomicHelperRejection";
}
export {};
