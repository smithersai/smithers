/**
 * Tagged faults raised inside the jj adapters before a public `JjError` is
 * built. The adapter that catches one completes it as a `JjError` whose `cause`
 * carries the fault's `name` and `code`, so a caller can tell which check
 * refused without parsing a message.
 *
 * @since 1.0.0
 */
import * as Schema from "effect/Schema";
/**
 * Why an adapter refused before or while running jj.
 *
 * @category models
 * @since 1.0.0
 */
export declare const JjInternalFaultCode: Schema.Literals<readonly ["reactor_disposed", "reactor_instantiation_failed", "reactor_abi_incomplete", "reactor_request_allocation_failed", "reactor_response_allocation_failed", "reactor_symlinks_unsupported", "patch_path_metadata_invalid", "patch_path_metadata_incomplete", "patch_headers_disagree", "patch_output_unexpected", "wasi_not_initialized", "lock_timeout"]>;
/**
 * The stable code of a {@link JjInternalFault}.
 *
 * @category models
 * @since 1.0.0
 */
export type JjInternalFaultCode = typeof JjInternalFaultCode.Type;
declare const JjInternalFault_base: Schema.Class<JjInternalFault, Schema.TaggedStruct<"@smthrs/jj/JjInternalFault", {
    readonly code: Schema.Literals<readonly ["reactor_disposed", "reactor_instantiation_failed", "reactor_abi_incomplete", "reactor_request_allocation_failed", "reactor_response_allocation_failed", "reactor_symlinks_unsupported", "patch_path_metadata_invalid", "patch_path_metadata_incomplete", "patch_headers_disagree", "patch_output_unexpected", "wasi_not_initialized", "lock_timeout"]>;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * A browser-reactor or patch-metadata check that refused.
 *
 * @category errors
 * @since 1.0.0
 */
export declare class JjInternalFault extends JjInternalFault_base {
    readonly name = "JjInternalFault";
}
export {};
