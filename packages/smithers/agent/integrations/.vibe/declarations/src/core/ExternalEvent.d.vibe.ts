/**
 * The normalized event every integration source produces.
 *
 * A webhook delivery and a long-poll update arrive in different shapes from
 * different providers. Both are decoded into one `ExternalEvent` before
 * anything downstream sees them, so the control-plane binding is written once
 * rather than once per provider.
 *
 * @since 1.0.0
 */
import { Schema } from "effect";
/**
 * A decoded external event.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const ExternalEvent: Schema.Struct<{
    /** The source that produced it: `github`. */
    readonly source: Schema.NonEmptyString;
    /**
     * The signal name, `integration:<service>:<event>`.
     *
     * The same refinement `SignalName.eventName` builds against, so a name that
     * module could not have produced, such as one whose event segment carries a
     * second colon, cannot enter persistence and become a routing identity
     * nothing can rebuild.
     */
    readonly eventName: Schema.refine<string, Schema.String>;
    /** What the event is about, or `null` when it addresses nothing narrower. */
    readonly correlationId: Schema.NullOr<Schema.String>;
    /** The provider payload, as delivered. */
    readonly payload: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    /** The provider's stable delivery identity, used to drop redeliveries. */
    readonly dedupeKey: Schema.NonEmptyString;
    /** When the event was received, in Unix milliseconds. */
    readonly receivedAtMs: Schema.Number;
}>;
/**
 * A decoded external event.
 *
 * @category models
 * @since 1.0.0
 */
export type ExternalEvent = typeof ExternalEvent.Type;
/**
 * Decodes an unknown value as an {@link ExternalEvent}.
 *
 * Sources decode their own output through this at the ingress boundary, so a
 * decoder bug fails loudly there instead of surfacing as a malformed signal
 * three hops later.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const decode: (input: unknown, options?: import("effect/SchemaAST").ParseOptions) => import("effect/Effect").Effect<{
    readonly source: string;
    readonly eventName: string;
    readonly correlationId: string | null;
    readonly payload: Schema.Json;
    readonly dedupeKey: string;
    readonly receivedAtMs: number;
}, Schema.SchemaError, never>;
