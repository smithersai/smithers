/**
 * HTTP POST flow declaration and portable handler.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
/**
 * Registry name for the http-post flow.
 *
 * @category identifiers
 * @since 1.0.0
 */
export declare const name = "http-post";
/**
 * Model-facing description of the http-post flow.
 *
 * @category descriptions
 * @since 1.0.0
 */
export declare const description = "Post a text body to an absolute URL and return the response; this is irreversible because the remote side may already have acted.";
/**
 * Input schema for the http-post flow.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Input: Schema.Struct<{
    readonly url: Schema.String;
    readonly body: Schema.String;
    readonly contentType: Schema.optional<Schema.String>;
    readonly headers: Schema.optional<Schema.$Record<Schema.String, Schema.String>>;
    readonly timeout: Schema.optional<Schema.Number>;
}>;
/**
 * Decoded input accepted by the `http-post` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type;
/**
 * Output schema for the http-post flow.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Output: Schema.Struct<{
    readonly status: Schema.Number;
    readonly body: Schema.String;
    readonly truncated: Schema.Boolean;
    readonly notice: Schema.optional<Schema.String>;
}>;
/**
 * Decoded output returned by the `http-post` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Output = typeof Output.Type;
/**
 * Static effect envelope for the http-post flow.
 *
 * @category effects
 * @since 1.0.0
 */
export declare const effects: import("@smthrs/plan/Effects").Declaration;
/**
 * Narrows the http-post effect envelope for one decoded input.
 *
 * Network reach is expressed as a capability rather than a path envelope, so
 * a post has nothing left to narrow.
 *
 * @category effects
 * @since 1.0.0
 */
export declare const effectsFor: (_input: typeof Input.Type) => import("@smthrs/plan/Effects").Declaration;
/**
 * Capabilities required by the http-post flow.
 *
 * @category capabilities
 * @since 1.0.0
 */
export declare const capabilities: string[];
/**
 * Declaration-only http-post flow.
 *
 * @category flows
 * @since 1.0.0
 */
export declare const flow: {
    readonly name: "http-post";
    readonly description: "Post a text body to an absolute URL and return the response; this is irreversible because the remote side may already have acted.";
    readonly input: Schema.Struct<{
        readonly url: Schema.String;
        readonly body: Schema.String;
        readonly contentType: Schema.optional<Schema.String>;
        readonly headers: Schema.optional<Schema.$Record<Schema.String, Schema.String>>;
        readonly timeout: Schema.optional<Schema.Number>;
    }>;
    readonly output: Schema.Struct<{
        readonly status: Schema.Number;
        readonly body: Schema.String;
        readonly truncated: Schema.Boolean;
        readonly notice: Schema.optional<Schema.String>;
    }>;
    readonly capabilities: string[];
    readonly effects: import("@smthrs/plan/Effects").Declaration;
};
/**
 * Posts a body through the permission-aware kernel HTTP client.
 *
 * @category handlers
 * @since 1.0.0
 */
export declare const run: (input: {
    readonly url: string;
    readonly body: string;
    readonly contentType?: string | undefined;
    readonly headers?: {
        readonly [x: string]: string;
    } | undefined;
    readonly timeout?: number | undefined;
}) => Effect.Effect<{
    readonly status: number;
    readonly body: string;
    readonly truncated: boolean;
    readonly notice?: string | undefined;
}, import("./StdError.vibe").StdError, import("@smthrs/kernel/GrantStore").GrantStore | import("effect/http/HttpClient").HttpClient>;
