/**
 * Typed registry failures, shaped after `effect/PlatformError`.
 *
 * Codes are a stable public contract: callers branch on them and UIs map them
 * to remediation. Never repurpose a code; add one.
 *
 * Governing contract: `packages/smithers/agent/registry/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/registry.
 *
 * @since 0.1.0
 */
import { Schema } from "effect";
/**
 * Stable reasons a source scan can fail.
 *
 * @category models
 * @since 0.1.0
 */
export declare const DiscoveryErrorCode: Schema.Literals<readonly ["root_missing", "read_failed", "invalid_root", "unknown"]>;
/**
 * Stable reasons a source scan can fail.
 *
 * @category models
 * @since 0.1.0
 */
export type DiscoveryErrorCode = typeof DiscoveryErrorCode.Type;
declare const DiscoveryError_base: Schema.Class<DiscoveryError, Schema.TaggedStruct<"flows/registry/DiscoveryError", {
    readonly code: Schema.Literals<readonly ["root_missing", "read_failed", "invalid_root", "unknown"]>;
    readonly module: Schema.optional<Schema.String>;
    readonly method: Schema.optional<Schema.String>;
    readonly path: Schema.optional<Schema.String>;
    readonly message: Schema.String;
    readonly cause: Schema.optional<Schema.Defect>;
}>, import("effect/Cause").YieldableError>;
/**
 * A failure while discovering entries in one registry source.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class DiscoveryError extends DiscoveryError_base {
}
/**
 * Stable reasons registry construction, lookup, or prompt rendering can fail.
 *
 * @category models
 * @since 0.1.0
 */
export declare const RegistryErrorCode: Schema.Literals<readonly ["not_found", "system_collision", "body_unavailable", "execution_changed", "not_prompt_flow", "invalid_pack", "incompatible_pack", "unreadable_pack_range", "unknown"]>;
/**
 * Stable reasons registry construction, lookup, or prompt rendering can fail.
 *
 * @category models
 * @since 0.1.0
 */
export type RegistryErrorCode = typeof RegistryErrorCode.Type;
declare const RegistryError_base: Schema.Class<RegistryError, Schema.TaggedStruct<"flows/registry/RegistryError", {
    readonly code: Schema.Literals<readonly ["not_found", "system_collision", "body_unavailable", "execution_changed", "not_prompt_flow", "invalid_pack", "incompatible_pack", "unreadable_pack_range", "unknown"]>;
    readonly module: Schema.optional<Schema.String>;
    readonly method: Schema.optional<Schema.String>;
    readonly path: Schema.optional<Schema.String>;
    readonly message: Schema.String;
    readonly cause: Schema.optional<Schema.Defect>;
}>, import("effect/Cause").YieldableError>;
/**
 * A failure while constructing, looking up, loading, or rendering a registry
 * entry.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class RegistryError extends RegistryError_base {
}
/**
 * Every failure the Registry layer is allowed to surface.
 *
 * @category models
 * @since 0.1.0
 */
export type RegistryFailure = DiscoveryError | RegistryError;
/**
 * Creates a `DiscoveryError` from a failed source-discovery operation.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const discoveryError: (options: {
    readonly code: DiscoveryErrorCode;
    readonly module?: string | undefined;
    readonly method: string;
    readonly path?: string | undefined;
    readonly description?: string | undefined;
    readonly cause?: unknown;
}) => DiscoveryError;
/**
 * Creates a `RegistryError` from a failed registry operation.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const registryError: (options: {
    readonly code: RegistryErrorCode;
    readonly module?: string | undefined;
    readonly method: string;
    readonly path?: string | undefined;
    readonly description?: string | undefined;
    readonly cause?: unknown;
}) => RegistryError;
export {};
