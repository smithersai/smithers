/**
 * Validated collector endpoints for the OTLP exporters.
 *
 * The endpoint is the field an operator most often gets wrong, and a wrong one
 * is invisible: Effect's exporter absorbs export failure by design, so a layer
 * built against `""` or `"localhost:4318"` looks identical to a working one and
 * simply never delivers. Every builder therefore decodes its endpoint during
 * layer acquisition, the same posture `Resource` already takes.
 *
 * @since 1.0.0-rc.0
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
/**
 * Largest collector endpoint accepted by a builder.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const maximumEndpointLength = 2048;
/**
 * Runtime schema for an absolute `http:` or `https:` collector endpoint that
 * carries no credentials, query, fragment, backslashes, spaces, or controls.
 * A base path is allowed; authentication belongs in exporter headers.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const Endpoint: Schema.String;
declare const InvalidExporterEndpoint_base: Schema.Class<InvalidExporterEndpoint, Schema.TaggedStruct<"@smthrs/observability/InvalidExporterEndpoint", {
    readonly code: Schema.Literal<"invalid_exporter_endpoint">;
    readonly path: Schema.String;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * Stable exporter-endpoint refusal shared by every OTLP builder.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export declare class InvalidExporterEndpoint extends InvalidExporterEndpoint_base {
}
/**
 * Removes the repeated trailing separators that would otherwise produce a
 * double slash in a signal URL.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export declare const normalize: (endpoint: string) => string;
/**
 * Decodes one collector endpoint into its normalized form without retaining
 * the rejected value.
 *
 * `path` names the option the endpoint arrived on, so the refusal points at the
 * caller's own field rather than at a shared internal name.
 *
 * @category decoding
 * @since 1.0.0-rc.0
 */
export declare const decode: (endpoint: unknown, path: string) => Effect.Effect<string, InvalidExporterEndpoint>;
/**
 * Builds the OTLP/HTTP URL one signal is posted to below a decoded endpoint.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export declare const signalUrl: (endpoint: string, signal: "traces" | "metrics" | "logs") => string;
export {};
