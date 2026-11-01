/**
 * The single typed failure of the plugin kernel.
 *
 * The public package contract is documented at
 * {@link https://smithers.sh/docs/reference/api/plugin}; D14 in
 * `docs/pages/design-decisions.md` bounds it to host-owned cell hooks.
 *
 * @since 1.0.0-rc.0
 */
import * as Schema from "effect/Schema";
/**
 * Closed set of plugin-system failure codes.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export declare const PluginErrorCode: Schema.Literals<readonly ["duplicate_name", "unknown_hook", "hook_kind_mismatch", "invalid_plugin", "apply_failed", "config_invalid", "cache_environment_invalid", "invalid_hook_result", "resource_limit", "hook_failed", "layer_failed"]>;
/**
 * Closed set of plugin-system failure codes.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type PluginErrorCode = typeof PluginErrorCode.Type;
declare const PluginError_base: Schema.Class<PluginError, Schema.TaggedStruct<"flows/plugin/PluginError", {
    readonly code: Schema.Literals<readonly ["duplicate_name", "unknown_hook", "hook_kind_mismatch", "invalid_plugin", "apply_failed", "config_invalid", "cache_environment_invalid", "invalid_hook_result", "resource_limit", "hook_failed", "layer_failed"]>;
    readonly message: Schema.String;
    readonly plugin: Schema.optional<Schema.String>;
    readonly hook: Schema.optional<Schema.String>;
    readonly path: Schema.optional<Schema.String>;
    readonly cause: Schema.optional<Schema.Unknown>;
}>, import("effect/Cause").YieldableError>;
/**
 * Failure raised by plugin resolution, hook dispatch, config execution, or
 * layer construction.
 *
 * Parallel observer failures never fail the caller; they are returned from
 * `Plugins.parallel` with this same shape so they can be journalled on the
 * lossy telemetry channel.
 *
 * `cause` is the plugin's unredacted failure and may hold secrets; hosts
 * redact it before logging, persisting, or transmitting the error.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export declare class PluginError extends PluginError_base {
}
export {};
