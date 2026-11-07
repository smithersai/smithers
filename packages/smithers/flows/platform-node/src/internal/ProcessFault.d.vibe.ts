/**
 * A process supervision failure that is not a native errno: a supervisor that
 * broke its status protocol, a bound that was exceeded, or a cleanup that could
 * not be verified. `ProcessSupervisor` and `WindowsProcessJob` report one as the
 * `cause` of a `PlatformError`, so a caller classifies it by `_tag` and `code`.
 * @since 1.0.0
 */
import { Schema } from "effect";
/**
 * Which supervision rule failed. `startup_timeout` is a start that missed its
 * bound, usually a busy machine, and is reported with the `TimedOut` tag so a
 * caller can retry it; `supervisor_timeout` is any other missed bound.
 * @category models
 * @since 1.0.0
 */
export declare const ProcessFaultCode: Schema.Literals<readonly ["startup_timeout", "supervisor_timeout", "runtime_unsupported", "identity_mismatch", "control_channel_closed", "configuration_too_large", "outcome_missing", "status_too_large", "status_invalid", "status_unknown", "cleanup_unverified", "owner_identity_missing"]>;
/**
 * The stable code of a {@link ProcessFault}.
 * @category models
 * @since 1.0.0
 */
export type ProcessFaultCode = typeof ProcessFaultCode.Type;
declare const ProcessFault_base: Schema.Class<ProcessFault, Schema.TaggedStruct<"@smthrs/platform-node/ProcessFault", {
    readonly code: Schema.Literals<readonly ["startup_timeout", "supervisor_timeout", "runtime_unsupported", "identity_mismatch", "control_channel_closed", "configuration_too_large", "outcome_missing", "status_too_large", "status_invalid", "status_unknown", "cleanup_unverified", "owner_identity_missing"]>;
    readonly message: Schema.String;
    readonly cause: Schema.optional<Schema.Unknown>;
}>, import("effect/Cause").YieldableError>;
/**
 * A supervision failure with a stable code.
 * @category errors
 * @since 1.0.0
 */
export declare class ProcessFault extends ProcessFault_base {
    readonly name = "ProcessFault";
}
/**
 * A process fault with a stable code.
 * @category constructors
 * @since 1.0.0
 */
export declare const processFault: (code: ProcessFaultCode, message: string, detail?: {
    readonly cause?: unknown;
}) => ProcessFault;
declare const NativeProcessError_base: Schema.Class<NativeProcessError, Schema.TaggedStruct<"@smthrs/platform-node/NativeProcessError", {
    readonly message: Schema.String;
    readonly code: Schema.optional<Schema.String>;
    readonly errno: Schema.optional<Schema.Number>;
    readonly reason: Schema.optional<Schema.String>;
    readonly syscall: Schema.optional<Schema.String>;
    readonly path: Schema.optional<Schema.String>;
    readonly signal: Schema.optional<Schema.String>;
}>, import("effect/Cause").YieldableError>;
/**
 * A native process failure as data: the errno (`code`), `syscall`, `path` or
 * `signal` the platform or the isolated owner reported, kept as fields of the
 * `PlatformError` cause so callers read the platform's own vocabulary.
 * `reason` is the stable code the owner program gave its own fault.
 * @category errors
 * @since 1.0.0
 */
export declare class NativeProcessError extends NativeProcessError_base {
    readonly name = "NativeProcessError";
}
export {};
