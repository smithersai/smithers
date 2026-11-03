/**
 * HTTP GET flow declaration and portable handler.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
/**
 * Registry name for the fetch flow.
 *
 * @category identifiers
 * @since 1.0.0
 */
export declare const name = "fetch";
/**
 * Model-facing description of the fetch flow.
 *
 * @category descriptions
 * @since 1.0.0
 */
export declare const description = "Get an absolute URL and return its status and text body; long bodies are truncated with a notice. Use http-post to send data.";
/**
 * Input schema for the fetch flow.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Input: Schema.Struct<{
    readonly url: Schema.String;
    readonly headers: Schema.optional<Schema.$Record<Schema.String, Schema.String>>;
    readonly timeout: Schema.optional<Schema.Number>;
}>;
/**
 * Decoded input accepted by the `fetch` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type;
/**
 * Output schema for the fetch flow.
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
 * Decoded output returned by the `fetch` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Output = typeof Output.Type;
/**
 * Static effect envelope for the fetch flow.
 *
 * A retrieval leaves no durable state behind, so it is sealed even though it
 * leaves the machine.
 *
 * @category effects
 * @since 1.0.0
 */
export declare const effects: import("@smthrs/plan/Effects").Declaration;
/**
 * Narrows the fetch effect envelope for one decoded input.
 *
 * Network reach is expressed as a capability rather than a path envelope, so
 * a retrieval has nothing left to narrow.
 *
 * @category effects
 * @since 1.0.0
 */
export declare const effectsFor: (_input: typeof Input.Type) => import("@smthrs/plan/Effects").Declaration;
/**
 * Capabilities required by the fetch flow.
 *
 * @category capabilities
 * @since 1.0.0
 */
export declare const capabilities: string[];
/**
 * Declaration-only fetch flow.
 *
 * @category flows
 * @since 1.0.0
 */
export declare const flow: {
    readonly name: "fetch";
    readonly description: "Get an absolute URL and return its status and text body; long bodies are truncated with a notice. Use http-post to send data.";
    readonly input: Schema.Struct<{
        readonly url: Schema.String;
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
 * Retrieves a URL through the permission-aware kernel HTTP client.
 *
 * Error statuses are ordinary results; only transport, permission, and body
 * decoding failures use the typed error channel.
 *
 * @category handlers
 * @since 1.0.0
 */
export declare const run: (input: {
    readonly url: string;
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
