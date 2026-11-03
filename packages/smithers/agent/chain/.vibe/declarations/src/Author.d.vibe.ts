/**
 * The author seat — the one thing the chain needs from a model.
 *
 * The seat is mocked at this boundary, not at the provider wire: the model
 * layer sits beneath a production implementation and no chain code changes
 * when it arrives. The author call carries no tools; the root stays
 * clean (https://chain.smithers.sh/contract/).
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer, Schema } from "effect";
declare const AuthorError_base: Schema.Class<AuthorError, Schema.TaggedStruct<"/chain/AuthorError", {
    readonly code: Schema.Literals<readonly ["author_unavailable", "exhausted"]>;
    readonly message: Schema.String;
    /**
     * The underlying typed condition when one exists — a model failure code
     * (`rate_limited`, `context_overflow`), a permission tag, or a stop
     * reason (`length`, `content-filter`) — so callers branch on it rather
     * than parsing prose.
     */
    readonly cause: Schema.optional<Schema.String>;
}>, import("effect/Cause").YieldableError>;
/**
 * A failure of the author seat: the seat is unreachable, or a scripted mock
 * ran out of outputs.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export declare class AuthorError extends AuthorError_base {
}
/**
 * What the harness hands the seat: the stable fixed prefix and the context
 * the previous link's code built — nothing else.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Input {
    readonly prefix: string;
    readonly context: ReadonlyArray<string>;
}
/**
 * Normalizes an author call's payload into its context lines: scripts call
 * the author entry with `{ context: [...] }`, and anything else — a script
 * passing garbage stays a journaled observation, never a crash — normalizes
 * to no context.
 * Context elements use string coercion, falling back to JSON text when
 * coercion fails, or `[unprintable context]` if serialization also fails.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const contextOf: (payload: unknown) => ReadonlyArray<string>;
/**
 * The seat's one operation: turn an author input into the raw model output
 * the chain extracts a script from.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface Service {
    readonly author: (input: Input) => Effect.Effect<string, AuthorError>;
}
declare const Author_base: Context.ServiceClass<Author, "/chain/Author", Service>;
/**
 * The author seat service tag.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export declare class Author extends Author_base {
}
/**
 * Builds a seat from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const make: (implementation: Service) => Service;
/**
 * A seat whose every operation fails as unavailable, with per-operation
 * overrides — the default a test starts from.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const makeNoop: (overrides?: Partial<Service>) => Service;
/**
 * The unavailable seat as a layer.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export declare const layerNoop: (overrides?: Partial<Service>) => Layer.Layer<Author>;
/**
 * A reactive mock: the test supplies the function from input to raw model
 * output, and can capture the inputs it saw.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export declare const layerFn: (f: (input: Input) => string) => Layer.Layer<Author>;
/**
 * A scripted mock: pops canned raw outputs in order and fails with
 * `exhausted` when asked for more than it holds. The outputs are copied
 * when the layer is constructed, so a later edit of the caller's array
 * changes nothing.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export declare const layerMock: (outputs: ReadonlyArray<string>) => Layer.Layer<Author>;
export {};
