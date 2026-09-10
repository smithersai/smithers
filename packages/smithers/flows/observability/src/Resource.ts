/**
 * Explicit, validated OpenTelemetry resource metadata for Smithers.
 *
 * @since 0.1.0
 */
import * as OtelResource from "@effect/opentelemetry/Resource"
import type { Attributes as OtelAttributes } from "@opentelemetry/api"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { schemaIssuePath } from "./internal/schemaIssuePath.ts"

/**
 * Largest service-name or service-version field accepted by a resource.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumIdentityLength = 1_024

/**
 * Largest attribute key accepted by a resource.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumAttributeKeyLength = 1_024

/**
 * Largest string value accepted by one resource attribute.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumAttributeStringLength = 65_536

/**
 * Largest number of attributes accepted by one resource.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumAttributes = 256

const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const embeddedNul = new RegExp(String.fromCharCode(0))

const isWellFormed = (value: string): boolean => !loneSurrogate.test(value) && !embeddedNul.test(value)

const identity = Schema.NonEmptyString.check(
  Schema.isMaxLength(maximumIdentityLength),
  Schema.makeFilter((value: string) => isWellFormed(value), { title: "wellFormedResourceIdentity" })
)

const attributeString = Schema.String.check(
  Schema.isMaxLength(maximumAttributeStringLength),
  Schema.makeFilter((value: string) => isWellFormed(value), { title: "wellFormedAttributeString" })
)

const attributeNumber = Schema.Number.check(
  Schema.makeFilter((value: number) => Number.isFinite(value), { title: "finiteAttributeNumber" })
)

/**
 * Runtime schema for one OpenTelemetry resource attribute value.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const AttributeValue = Schema.Union([
  attributeString,
  attributeNumber,
  Schema.Boolean,
  Schema.Array(attributeString),
  Schema.Array(attributeNumber),
  Schema.Array(Schema.Boolean)
])

/**
 * Runtime schema for OpenTelemetry resource attributes.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const Attributes = Schema.Record(Schema.String, AttributeValue).check(
  Schema.makeFilter(
    (attributes: Readonly<Record<string, unknown>>) => Object.keys(attributes).length <= maximumAttributes,
    { title: "boundedResourceAttributes" }
  ),
  Schema.makeFilter(
    (attributes: Readonly<Record<string, unknown>>) =>
      Object.keys(attributes).every(
        (key) => key.length > 0 && key.length <= maximumAttributeKeyLength && isWellFormed(key)
      ),
    { title: "wellFormedResourceAttributeKeys" }
  )
)

/**
 * Runtime schema for the service identity attached to exported telemetry.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const Configuration = Schema.Struct({
  serviceName: identity,
  serviceVersion: Schema.optional(identity),
  attributes: Schema.optional(Attributes)
})

/**
 * Configuration used to identify the service emitting telemetry.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Configuration = typeof Configuration.Type

/**
 * Stable resource-configuration refusal shared by every OTEL layer.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export class InvalidResourceConfiguration extends Schema.TaggedError<InvalidResourceConfiguration>()(
  "@smthrs/observability/InvalidResourceConfiguration",
  {
    code: Schema.Literal("invalid_resource_configuration"),
    path: Schema.String,
    message: Schema.String
  }
) {}

const invalid = (cause: unknown): InvalidResourceConfiguration => {
  const path = schemaIssuePath(cause, "resource")
  return new InvalidResourceConfiguration({
    code: "invalid_resource_configuration",
    path,
    message: `OpenTelemetry resource ${path} is invalid`
  })
}

/**
 * Decodes one resource configuration without retaining rejected values.
 *
 * @category decoding
 * @since 1.0.0-rc.0
 */
export const decode = (
  configuration: unknown
): Effect.Effect<Configuration, InvalidResourceConfiguration> =>
  Schema.decodeUnknownEffect(Configuration)(configuration).pipe(Effect.mapError(invalid))

/**
 * Decodes one resource configuration for the package's pure projection API.
 *
 * @category decoding
 * @since 1.0.0-rc.0
 */
export const decodeSync = (configuration: unknown): Configuration => {
  try {
    return Schema.decodeUnknownSync(Configuration)(configuration)
  } catch (cause) {
    throw invalid(cause)
  }
}

/**
 * Projects a decoded resource into the exact optional-property shape expected
 * by the OpenTelemetry SDK.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const toOpenTelemetryConfiguration = (
  configuration: Configuration
): {
  readonly serviceName: string
  readonly serviceVersion?: string
  readonly attributes?: OtelAttributes
} => ({
  serviceName: configuration.serviceName,
  ...(configuration.serviceVersion === undefined ? {} : { serviceVersion: configuration.serviceVersion }),
  ...(configuration.attributes === undefined
    ? {}
    : {
      attributes: Object.fromEntries(
        Object.entries(configuration.attributes).map(([key, value]) => [
          key,
          Array.isArray(value) ? [...value] : value
        ])
      ) as OtelAttributes
    })
})

/**
 * Converts explicit service metadata into OpenTelemetry resource attributes.
 *
 * No environment variables are read. Invalid metadata throws the same typed
 * {@link InvalidResourceConfiguration} every layer returns during acquisition.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const configToAttributes = (configuration: Configuration): OtelAttributes =>
  OtelResource.configToAttributes(toOpenTelemetryConfiguration(decodeSync(configuration)))

/**
 * Provides an explicitly validated OpenTelemetry resource.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = (
  configuration: Configuration
): Layer.Layer<OtelResource.Resource, InvalidResourceConfiguration> =>
  Layer.unwrap(
    Effect.map(decode(configuration), (decoded) => OtelResource.layer(toOpenTelemetryConfiguration(decoded)))
  )

/**
 * The OpenTelemetry resource service.
 *
 * @category services
 * @since 1.0.0-rc.0
 */
export const Resource = OtelResource.Resource
