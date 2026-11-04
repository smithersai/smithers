/**
 * Bounded plugin resolution: admit, filter, validate, order, and snapshot.
 *
 * The resulting catalog owns every record it exposes. Dispatch never reads a
 * caller-owned map, plugin record, hook object, config value, or cache identity.
 *
 * @since 1.0.0-rc.0
 */
import type { Action } from "@smthrs/flow";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { FlowsConfig } from "./Config.vibe";
import type { HookCatalog, HookKind } from "./Hooks.vibe";
import type { FlowsHooks } from "./index.vibe";
import type { FlowsPlugin, PluginInput } from "./Plugin.vibe";
import { PluginError } from "./PluginError.vibe";
/**
 * Maximum nested preset-array depth accepted at startup.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export declare const maximumPluginDepth = 64;
/**
 * Maximum plugins accepted by one kernel.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export declare const maximumPlugins = 256;
/**
 * Maximum aggregate hook handlers accepted by one kernel.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export declare const maximumHandlers = 1024;
/**
 * Maximum input nodes, including arrays and omitted entries.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export declare const maximumPluginInputNodes = 4096;
/**
 * Maximum UTF-16 length of one plugin or hook name.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export declare const maximumPluginNameLength = 256;
/**
 * Default fiber bound for parallel observers.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export declare const defaultParallelConcurrency = 16;
/**
 * Maximum configurable parallel-observer bound.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export declare const maximumParallelConcurrency = 256;
/**
 * One resolved handler with immutable attribution.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface HandlerRecord {
    readonly plugin: string;
    readonly hook: string;
    readonly handler: (...args: Array<any>) => unknown;
}
/**
 * The immutable output of plugin resolution.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Resolved<H = FlowsHooks> {
    readonly plugins: ReadonlyArray<FlowsPlugin<H>>;
    readonly handlers: ReadonlyMap<string, ReadonlyArray<HandlerRecord>>;
    /** The frozen runtime catalog this resolution admitted. Dispatch refuses a method whose kind differs from it. */
    readonly kinds: Readonly<Record<string, HookKind>>;
    readonly parallelConcurrency: number;
    readonly cacheEnvironment?: Action.CacheEnvironment | undefined;
}
/**
 * Options for {@link resolve}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Options<H = FlowsHooks> {
    /** Pre-resolution config tested by `apply` predicates. */
    readonly config?: FlowsConfig | undefined;
    /** Host whose literal `apply` selectors are active. Defaults to `"engine"`. */
    readonly target?: "engine" | "harness" | undefined;
    /**
     * Hook names recognized by this host, each with the kind `H` declares for
     * it. The shared `config` and `configResolved` hooks are fixed to
     * `waterfall` and `parallel`; another kind fails with `hook_kind_mismatch`.
     */
    readonly hooks?: HookCatalog<H> | undefined;
    /** Complete composition identity for sealed activity keys. Requires every selected plugin to have a version. */
    readonly cacheEnvironment?: Action.CacheEnvironment | undefined;
    /** Maximum observers run at once. Defaults to 16 and cannot exceed 256. */
    readonly parallelConcurrency?: number | undefined;
}
/**
 * Resolves a plugin preset into an immutable, resource-bounded catalog.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const resolve: <H = FlowsHooks>(input: PluginInput<NoInfer<H>>, options?: Options<NoInfer<H>>, configOverride?: FlowsConfig) => Effect.Effect<Resolved<H>, PluginError>;
/**
 * Merges every resolved plugin layer left-to-right and supplies the detached
 * cache environment captured during resolution.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export declare const layer: <H>(resolved: Resolved<H>) => Layer.Layer<any, PluginError, any>;
