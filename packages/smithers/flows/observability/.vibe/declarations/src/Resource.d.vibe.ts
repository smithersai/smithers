/**
 * Explicit, validated OpenTelemetry resource metadata for Smithers.
 *
 * @since 0.1.0
 */
import * as OtelResource from "@effect/opentelemetry/Resource";
import type { Attributes as OtelAttributes } from "@opentelemetry/api";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/**
 * Largest service-name or service-version field accepted by a resource.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const maximumIdentityLength = 1024;
/**
 * Largest attribute key accepted by a resource.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const maximumAttributeKeyLength = 1024;
/**
 * Largest string value accepted by one resource attribute.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const maximumAttributeStringLength = 65536;
/**
 * Largest number of elements accepted in one array attribute value.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const maximumAttributeArrayLength = 256;
/**
 * Largest number of attributes accepted by one resource.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const maximumAttributes = 256;
/**
 * Largest OTLP/JSON encoding accepted for one whole resource, in UTF-8 bytes.
 *
 * The measure is the OTLP `Resource` message the exporters place in every
 * request, `{"attributes":[{"key":…,"value":{…}}],"droppedAttributesCount":0}`
 * with service identity and SDK-added `telemetry.sdk.name`,
 * `telemetry.sdk.language` and `telemetry.sdk.version` included, after JSON
 * escaping and UTF-8 encoding. The SDK's own values are reserved even for the
 * default Effect exporter, whose values are shorter. A caller attribute that
 * replaces an SDK field, or that service identity overwrites, is counted
 * beside it. It is the bound the per-field limits cannot express: 256
 * attributes at the string ceiling would encode to 16 MiB, and the resource
 * rides in every export request, so the default transport, which discards a
 * request over 1 MiB, would deliver nothing at all. 128 KiB admits one
 * ASCII attribute at the string ceiling and leaves that transport 888 KiB of every
 * request for the signal batch; see `Otlp.reservedBatchBytes`.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const maximumResourceBytes = 131072;
/**
 * Runtime schema for one OpenTelemetry resource attribute value.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const AttributeValue: Schema.Union<readonly [Schema.String, Schema.Number, Schema.Boolean, Schema.$Array<Schema.String>, Schema.$Array<Schema.Number>, Schema.$Array<Schema.Boolean>]>;
/**
 * Runtime schema for OpenTelemetry resource attributes.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const Attributes: Schema.$Record<Schema.String, Schema.Union<readonly [Schema.String, Schema.Number, Schema.Boolean, Schema.$Array<Schema.String>, Schema.$Array<Schema.Number>, Schema.$Array<Schema.Boolean>]>>;
/**
 * Runtime schema for the service identity attached to exported telemetry.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const Configuration: Schema.Struct<{
    readonly serviceName: Schema.NonEmptyString;
    readonly serviceVersion: Schema.optional<Schema.NonEmptyString>;
    readonly attributes: Schema.optional<Schema.$Record<Schema.String, Schema.Union<readonly [Schema.String, Schema.Number, Schema.Boolean, Schema.$Array<Schema.String>, Schema.$Array<Schema.Number>, Schema.$Array<Schema.Boolean>]>>>;
}>;
/**
 * Configuration used to identify the service emitting telemetry.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Configuration = typeof Configuration.Type;
declare const InvalidResourceConfiguration_base: Schema.Class<InvalidResourceConfiguration, Schema.TaggedStruct<"@smthrs/observability/InvalidResourceConfiguration", {
    readonly code: Schema.Literal<"invalid_resource_configuration">;
    readonly path: Schema.String;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * Stable resource-configuration refusal shared by every OTEL layer.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export declare class InvalidResourceConfiguration extends InvalidResourceConfiguration_base {
}
/**
 * Decodes one resource configuration without retaining rejected values.
 *
 * @category decoding
 * @since 1.0.0-rc.0
 */
export declare const decode: (configuration: unknown) => Effect.Effect<Configuration, InvalidResourceConfiguration>;
/**
 * Decodes one resource configuration for the package's pure projection API.
 *
 * @category decoding
 * @since 1.0.0-rc.0
 */
export declare const decodeSync: (configuration: unknown) => Configuration;
/**
 * Projects a decoded resource into the exact optional-property shape expected
 * by the OpenTelemetry SDK.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export declare const toOpenTelemetryConfiguration: (configuration: Configuration) => {
    readonly serviceName: string;
    readonly serviceVersion?: string;
    readonly attributes?: OtelAttributes;
};
/**
 * Converts explicit service metadata into OpenTelemetry resource attributes.
 *
 * No environment variables are read. Invalid metadata throws the same typed
 * {@link InvalidResourceConfiguration} every layer returns during acquisition.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export declare const configToAttributes: (configuration: Configuration) => OtelAttributes;
/**
 * Provides an explicitly validated OpenTelemetry resource.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export declare const layer: (configuration: Configuration) => Layer.Layer<OtelResource.Resource, InvalidResourceConfiguration>;
/**
 * The OpenTelemetry resource service.
 *
 * @category services
 * @since 1.0.0-rc.0
 */
export declare const Resource: typeof OtelResource.Resource;
export {};
