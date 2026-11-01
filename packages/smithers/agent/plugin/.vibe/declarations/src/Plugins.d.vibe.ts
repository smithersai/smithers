/**
 * The dispatcher: a plain service over a resolved plugin list, generic over the
 * hook interface.
 *
 * The public package contract is documented at
 * {@link https://smithers.sh/docs/reference/api/plugin}. Each host holds an instance over its
 * augmented `FlowsHooks` and may dispatch only the runtime catalog it supplied.
 * The shipped cell host owns the three
 * waterfalls declared in `packages/smithers/agent/src/CellPlugin.ts`; there is
 * no engine-wide lifecycle dispatcher.
 *
 * Cancellation is fiber interruption via scope closure; nothing here threads an
 * `AbortSignal`.
 *
 * @since 1.0.0-rc.0
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ArgsOf, ContextOf, KeysOfKind, SuccessOf } from "./Hooks.vibe";
import type { FlowsHooks } from "./index.vibe";
import { PluginError } from "./PluginError.vibe";
import { type HandlerRecord, type Resolved } from "./Resolve.ts";
/**
 * The dispatch surface.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Service<H = FlowsHooks> {
    /** The resolved list this dispatcher walks. */
    readonly resolved: Resolved<H>;
    /** Frozen, ordered handler records for a hook. */
    readonly handlers: (hook: string) => ReadonlyArray<HandlerRecord>;
    /** Runs every handler in resolved order, one at a time. */
    readonly sequential: <K extends KeysOfKind<H, "sequential">>(hook: K, ...args: ArgsOf<H[K]>) => Effect.Effect<ReadonlyArray<SuccessOf<H[K]>>, PluginError, ContextOf<H[K]>>;
    /**
     * Runs every handler concurrently, ignoring results. Never fails: handler
     * failures are returned so the caller can report them at its own boundary.
     */
    readonly parallel: <K extends KeysOfKind<H, "parallel">>(hook: K, ...args: ArgsOf<H[K]>) => Effect.Effect<ReadonlyArray<PluginError>, never, ContextOf<H[K]>>;
    /** Runs handlers in order until one returns `Option.some`. */
    readonly first: <K extends KeysOfKind<H, "first">>(hook: K, ...args: ArgsOf<H[K]>) => Effect.Effect<SuccessOf<H[K]>, PluginError, ContextOf<H[K]>>;
    /** Threads a value through every handler, merging each returned patch. */
    readonly waterfall: <K extends KeysOfKind<H, "waterfall">>(hook: K, initial: ArgsOf<H[K]>[0], merge: (previous: ArgsOf<H[K]>[0], patch: Exclude<SuccessOf<H[K]>, void>) => ArgsOf<H[K]>[0]) => Effect.Effect<ArgsOf<H[K]>[0], PluginError, ContextOf<H[K]>>;
}
/**
 * Builds a dispatcher over an already resolved plugin list.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const make: <H = FlowsHooks>(resolved: Resolved<H>) => Service<H>;
/**
 * A dispatcher with no plugins at all.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const makeNoop: <H = FlowsHooks>() => Service<H>;
declare const Plugins_base: Context.ServiceClass<Plugins, "flows/plugin/Plugins", Service<FlowsHooks>>;
/**
 * The shared dispatcher, as a service tag.
 *
 * This tag holds one dispatcher over the process-wide augmented `FlowsHooks`.
 * `declare module "@smthrs/plugin"` augmentation is the supported extension
 * mechanism for values placed in the tag. A host typed against a separate hook
 * interface holds its `Service<H>` directly, as `@smthrs/agent` does, and does
 * not use this tag or its layers.
 *
 * @category context
 * @since 1.0.0-rc.0
 */
export declare class Plugins extends Plugins_base {
}
/**
 * Layer providing a dispatcher over an already resolved plugin list.
 *
 * This layer targets the shared augmented `FlowsHooks` catalog only. A host
 * with a separate hook interface holds its `Service<H>` directly.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export declare const layer: (resolved: Resolved) => Layer.Layer<Plugins>;
/**
 * Layer providing a dispatcher with no plugins.
 *
 * This layer targets the shared augmented `FlowsHooks` catalog only. A host
 * with a separate hook interface holds its `Service<H>` directly.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export declare const layerNoop: Layer.Layer<Plugins>;
export {};
