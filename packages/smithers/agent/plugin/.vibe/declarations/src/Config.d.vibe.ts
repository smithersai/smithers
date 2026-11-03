/**
 * Bounded JSON configuration consumed and produced by the plugin kernel.
 *
 * Configuration is an extension namespace, not an engine-policy surface.
 * Durable retry, concurrency, and storage policy stay on their owning Effect
 * services and constructor options. Every accepted value is copied before any
 * plugin observes it, then frozen recursively.
 *
 * @since 1.0.0-rc.0
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { PluginError } from "./PluginError.vibe";
/**
 * Maximum encoded bytes accepted for one plugin configuration.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export declare const maximumConfigBytes: number;
/**
 * Maximum nesting accepted for one plugin configuration.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export declare const maximumConfigDepth: number;
/**
 * Maximum aggregate members accepted for one plugin configuration.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export declare const maximumConfigMembers: number;
/**
 * Maximum aggregate values accepted for one plugin configuration.
 *
 * @category limits
 * @since 1.0.0-rc.0
 */
export declare const maximumConfigNodes: number;
/**
 * One value accepted in a plugin-owned configuration namespace.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export declare const ConfigValue: Schema.Codec<Schema.Json, Schema.Json, never, never>;
/**
 * One value accepted in a plugin-owned configuration namespace.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ConfigValue = typeof ConfigValue.Type;
/**
 * Admits pre-resolution configuration as a detached, recursively frozen snapshot.
 *
 * Keys name plugin-owned namespaces. `engine`, `retry`, `store`, and
 * `plugins` are refused because accepting those names would imply policy the
 * plugin kernel does not own or apply.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export declare const FlowsConfig: Schema.decodeTo<Schema.declare<Readonly<Record<string, Schema.Json>>, Readonly<Record<string, Schema.Json>>>, Schema.Unknown, never, never>;
/**
 * The decoded form of {@link FlowsConfig}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type FlowsConfig = typeof FlowsConfig.Type;
/**
 * Admits the detached, recursively frozen configuration handed to plugins.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export declare const ResolvedConfig: Schema.decodeTo<Schema.declare<Readonly<Record<string, Schema.Json>>, Readonly<Record<string, Schema.Json>>>, Schema.Unknown, never, never>;
/**
 * The decoded form of {@link ResolvedConfig}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ResolvedConfig = typeof ResolvedConfig.Type;
/**
 * Empty defaults. Engine policy is deliberately not defaulted here.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const defaults: ResolvedConfig;
/**
 * Copies and deep-merges a configuration patch over a base configuration.
 *
 * Records merge key-by-key and every other JSON value replaces wholesale.
 * Raw operands are admitted; known snapshots retain unchanged subtrees.
 * Cached subtree totals enforce merged output bounds. Unsafe property names,
 * accessors, cycles, exotic prototypes, and aggregate values outside the
 * resource limits fail with `config_invalid`.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export declare const merge: (base: FlowsConfig, patch: unknown) => FlowsConfig;
/**
 * Copies and freezes one JSON value without retaining caller-owned objects.
 *
 * @category utils
 * @since 1.0.0-rc.0
 */
export declare const deepFreeze: <A extends ConfigValue>(value: A) => A;
/**
 * Admits a raw pre-resolution configuration as an immutable snapshot.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const snapshot: (config: unknown) => Effect.Effect<FlowsConfig, PluginError>;
/**
 * Decodes the post-waterfall configuration into its final immutable form.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const resolve: (config: unknown) => Effect.Effect<ResolvedConfig, PluginError>;
