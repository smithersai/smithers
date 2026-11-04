/**
 * The grant-store failure.
 *
 * @since 0.1.0
 */
import { Schema } from "effect";
declare const GrantStoreError_base: Schema.Class<GrantStoreError, Schema.TaggedStruct<"@smthrs/capability/GrantStoreError", {
    readonly code: Schema.Literals<readonly ["duplicate_request", "request_not_found", "journal_failed", "store_closed", "invalid_resolution"]>;
    readonly message: Schema.optional<Schema.String>;
    readonly cause: Schema.optional<Schema.Defect>;
}>, import("effect/Cause").YieldableError>;
/**
 * A failure to register, persist, or resolve a grant request.
 *
 * `message` and `cause` are optional operation context for persistence
 * adapters; callers branch on the stable `code`.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export declare class GrantStoreError extends GrantStoreError_base {
}
export {};
