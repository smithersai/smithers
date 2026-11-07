/**
 * The immutable metadata projection of a discovered flow, and its lazy loader.
 *
 * @since 0.1.0
 */
import { Effect, Option } from "effect";
import type * as Flow from "@smthrs/core/Flow";
import * as Descriptor from "@smthrs/registry/Descriptor";
import { FsError } from "./FsError.vibe";
/**
 * Maximum number of path segments in one route.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maximumRouteDepth = 64;
/**
 * Maximum UTF-16 length of one route segment.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maximumSegmentLength = 255;
/**
 * Maximum UTF-16 length of one slash-joined route name.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maximumRouteNameLength = 4096;
/**
 * Maximum UTF-16 length of one source or companion path.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maximumPathLength = 16384;
/**
 * Maximum number of capabilities declared by one route.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maximumCapabilities = 256;
/**
 * How a route's body is stored on disk.
 *
 * @category models
 * @since 0.1.0
 */
export type Kind = "module" | "markdown" | "skill";
/**
 * A path-derived command route.
 *
 * Everything here comes from registry discovery, which never evaluates a flow
 * module. Materializing the flow is {@link load}.
 *
 * @category models
 * @since 0.1.0
 */
export interface Route {
    name: string;
    segments: ReadonlyArray<string>;
    kind: Kind;
    sourcePath: string;
    description: Option.Option<string>;
    input: Descriptor.SchemaRef;
    output: Descriptor.SchemaRef;
    capabilities: ReadonlyArray<string>;
    effects: Descriptor.EffectDeclaration;
    modelInvocable: boolean;
    placement: Option.Option<Descriptor.Placement>;
    ui: Option.Option<string>;
}
/**
 * Generated applications augment this map with route-specific input and output
 * types from the loaded schemas (Schema.Type, not Schema.Encoded).
 *
 * @example
 * ```ts
 * declare module "@smthrs/fs/Route" {
 *   interface Manifest {
 *     review: { readonly input: { readonly title: string }; readonly output: string }
 *   }
 * }
 * ```
 *
 * @category models
 * @since 0.1.0
 */
export interface Manifest {
}
/**
 * A route name, narrowed to generated manifest keys when one is available.
 *
 * @category models
 * @since 0.1.0
 */
export type Name = keyof Manifest extends never ? string : Extract<keyof Manifest, string>;
/**
 * The decoded input accepted by Command.call for a named route.
 *
 * @category models
 * @since 0.1.0
 */
export type Input<N extends Name> = N extends keyof Manifest ? Manifest[N] extends {
    input: infer I;
} ? I : unknown : unknown;
/**
 * The decoded output returned by Command.call for a named route.
 *
 * @category models
 * @since 0.1.0
 */
export type Output<N extends Name> = N extends keyof Manifest ? Manifest[N] extends {
    output: infer O;
} ? O : unknown : unknown;
declare const copyRoute: (input: Route) => Effect.Effect<Route, FsError>;
/**
 * Copies and validates caller-owned route metadata before asynchronous use.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const snapshot: typeof copyRoute;
/**
 * True only for routes the agent and Incur command surfaces may execute.
 *
 * @category guards
 * @since 0.1.0
 * @throws {never}
 */
export declare const isCommandRoute: (route: Route) => boolean;
type Loaded = Pick<Flow.Any, "name" | "input" | "output"> & Partial<Pick<Flow.Any, "description">>;
/**
 * Materializes the flow behind a route.
 *
 * Only module routes can be materialized here. Markdown and skill bodies are
 * registry inputs, not executable commands in this private adapter.
 *
 * A route marked model-invocable whose imported flow declares
 * `modelInvocable: false` fails with `load_failed`, so route metadata captured
 * before the author hid the flow cannot run it.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare function load(input: Route): Effect.Effect<Loaded, FsError>;
export {};
