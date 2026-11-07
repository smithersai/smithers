/**
 * The bounded, immutable segment trie shared by every command projection.
 *
 * @since 0.1.0
 */
import { Effect, Option } from "effect";
import { FsError } from "./FsError.vibe";
import * as Route from "./Route.vibe";
/**
 * Maximum routes accepted by one tree.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maximumRoutes = 256;
/**
 * Maximum total path segments accepted by one tree.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maximumTotalSegments = 4096;
/**
 * Maximum tokens accepted by one direct resolution request.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maximumResolutionTokens = 4096;
/**
 * A node of the command trie.
 *
 * A node may carry a route, children, or both: `domains` and `domains/list`
 * may both be routable in the same tree.
 *
 * @category models
 * @since 0.1.0
 */
export interface CommandTree {
    route: Option.Option<Route.Route>;
    children: ReadonlyMap<string, CommandTree>;
}
/**
 * A route selected from an argv prefix, with the unconsumed tokens.
 *
 * @category models
 * @since 0.1.0
 */
export interface Resolved {
    route: Route.Route;
    rest: ReadonlyArray<string>;
}
/**
 * Builds one immutable command trie.
 *
 * Two routes claiming the same segment path fail instead of shadowing one
 * another. Every route is detached before the first caller-observable await.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare function make(input: ReadonlyArray<Route.Route>): Effect.Effect<CommandTree, FsError>;
/**
 * Resolves the longest routable prefix of an argv.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare function resolve(tree: CommandTree, input: ReadonlyArray<string>): Effect.Effect<Resolved, FsError>;
/**
 * Resolves one complete route name and refuses unconsumed path segments.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare function resolveExact(tree: CommandTree, argv: ReadonlyArray<string>): Effect.Effect<Route.Route, FsError>;
/**
 * Lists every route in stable segment order.
 *
 * @category getters
 * @since 0.1.0
 * @throws {never}
 */
export declare const traverse: (tree: CommandTree) => ReadonlyArray<Route.Route>;
