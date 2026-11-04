/**
 * The `websearch` flow and the provider seam it runs through.
 *
 * The flow is provider-neutral: it hands the query to the bound
 * {@link WebSearch} service and returns normalized results. A host binds a
 * provider such as `ExaWebSearch.layer`; {@link layerNoop} fails every search
 * with `provider_unavailable`.
 *
 * @since 1.0.0
 */
import { Context, Effect, Layer, Schema } from "effect";
import * as StdError from "./StdError.vibe";
/**
 * The registry name of the `websearch` flow.
 *
 * @category identifiers
 * @since 1.0.0
 */
export declare const name = "websearch";
/**
 * The one-line description the model sees for the `websearch` flow.
 *
 * @category descriptions
 * @since 1.0.0
 */
export declare const description = "Search the web through a configured provider and return normalized results.";
/**
 * What the `websearch` flow accepts.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Input: Schema.Struct<{
    readonly query: Schema.NonEmptyString;
    readonly numResults: Schema.optional<Schema.Int>;
    readonly freshness: Schema.optional<Schema.Literals<readonly ["day", "week", "month", "year"]>>;
}>;
/**
 * Decoded input accepted by the `websearch` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type;
/**
 * One search hit, normalized across providers.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Result: Schema.Struct<{
    readonly title: Schema.String;
    readonly url: Schema.String;
    readonly snippet: Schema.String;
    readonly publishedAt: Schema.optional<Schema.String>;
}>;
/**
 * What the `websearch` flow returns.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Output: Schema.Struct<{
    readonly results: Schema.$Array<Schema.Struct<{
        readonly title: Schema.String;
        readonly url: Schema.String;
        readonly snippet: Schema.String;
        readonly publishedAt: Schema.optional<Schema.String>;
    }>>;
}>;
/**
 * Decoded output returned by the `websearch` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Output = typeof Output.Type;
/**
 * The declared effect envelope of the `websearch` flow, before any input is known.
 *
 * @category effects
 * @since 1.0.0
 */
export declare const effects: import("@smthrs/plan/Effects").Declaration;
/**
 * Narrows {@link effects} to what this particular input actually touches.
 *
 * @category effects
 * @since 1.0.0
 */
export declare const effectsFor: (_input: typeof Input.Type) => import("@smthrs/plan/Effects").Declaration;
/**
 * The authority the `websearch` flow requires.
 *
 * @category capabilities
 * @since 1.0.0
 */
export declare const capabilities: string[];
/**
 * The `websearch` flow declaration: schemas, capabilities, and effects, with the
 * implementation attached separately.
 *
 * @category flows
 * @since 1.0.0
 */
export declare const flow: {
    readonly name: "websearch";
    readonly description: "Search the web through a configured provider and return normalized results.";
    readonly input: Schema.Struct<{
        readonly query: Schema.NonEmptyString;
        readonly numResults: Schema.optional<Schema.Int>;
        readonly freshness: Schema.optional<Schema.Literals<readonly ["day", "week", "month", "year"]>>;
    }>;
    readonly output: Schema.Struct<{
        readonly results: Schema.$Array<Schema.Struct<{
            readonly title: Schema.String;
            readonly url: Schema.String;
            readonly snippet: Schema.String;
            readonly publishedAt: Schema.optional<Schema.String>;
        }>>;
    }>;
    readonly capabilities: string[];
    readonly effects: import("@smthrs/plan/Effects").Declaration;
};
/**
 * The provider seam a web search is served through.
 *
 * @category services
 * @since 1.0.0
 */
export interface WebSearch {
    readonly search: (input: typeof Input.Type) => Effect.Effect<typeof Output.Type, StdError.StdError>;
}
/**
 * The {@link WebSearch} service tag.
 *
 * @category services
 * @since 1.0.0
 */
export declare const WebSearch: Context.Service<WebSearch, WebSearch>;
/**
 * Builds a {@link WebSearch} from an implementation of its one method.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const make: (service: WebSearch) => WebSearch;
/**
 * A {@link WebSearch} that fails every search with `provider_unavailable`,
 * for an environment with no provider configured.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const makeNoop: () => WebSearch;
/**
 * Provides {@link makeNoop}.
 *
 * @category layers
 * @since 1.0.0
 */
export declare const layerNoop: Layer.Layer<WebSearch>;
/**
 * Runs the `websearch` flow: searches the web through the configured provider.
 *
 * @category handlers
 * @since 1.0.0
 */
export declare const run: (input: {
    readonly query: string;
    readonly numResults?: number | undefined;
    readonly freshness?: "day" | "month" | "week" | "year" | undefined;
}) => Effect.Effect<typeof Output.Type, StdError.StdError, WebSearch>;
