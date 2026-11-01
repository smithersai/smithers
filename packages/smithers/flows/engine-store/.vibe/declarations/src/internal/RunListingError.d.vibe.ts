/**
 * Shared catalog failure vocabulary.
 *
 * @since 1.0.0
 */
import * as Schema from "effect/Schema";
/**
 * Catalog failure codes.
 *
 * @category models
 * @since 0.1.0
 */
export declare const RunCatalogErrorCode: Schema.Literals<readonly ["invalid_options", "list_failed", "invalid_cursor", "source_changed"]>;
/**
 * Catalog failure codes.
 *
 * @category models
 * @since 0.1.0
 */
export type RunCatalogErrorCode = typeof RunCatalogErrorCode.Type;
declare const RunCatalogError_base: Schema.Class<RunCatalogError, Schema.TaggedStruct<"@smthrs/engine-store/RunCatalogError", {
    readonly code: Schema.Literals<readonly ["invalid_options", "list_failed", "invalid_cursor", "source_changed"]>;
    readonly message: Schema.String;
    readonly cause: Schema.optional<Schema.Unknown>;
}>, import("effect/Cause").YieldableError>;
/**
 * Catalog read failure retaining its original cause.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class RunCatalogError extends RunCatalogError_base {
}
export {};
