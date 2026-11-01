/**
 * Versioned facts for an authorized native cell invocation and its delivered result.
 * @since 1.0.0
 */
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
/** Stable harness coordinates, independent of physical attempt or publication order.
 * @category schemas
 * @since 1.0.0
 */
export declare const Identity: Schema.Struct<{
    /** Public logical run identity, not an authentication session credential. */
    readonly runId: Schema.String;
    readonly frame: Schema.Int;
    readonly cell: Schema.String;
    readonly ordinal: Schema.Int;
    readonly declaration: Schema.String;
    readonly layers: Schema.$Array<Schema.String>;
}>;
/** A call annotation contains data only and never changes an action key.
 * @category schemas
 * @since 1.0.0
 */
export declare const Call: Schema.Struct<{
    readonly callId: Schema.String;
    readonly identity: Schema.Struct<{
        /** Public logical run identity, not an authentication session credential. */
        readonly runId: Schema.String;
        readonly frame: Schema.Int;
        readonly cell: Schema.String;
        readonly ordinal: Schema.Int;
        readonly declaration: Schema.String;
        readonly layers: Schema.$Array<Schema.String>;
    }>;
    readonly flowName: Schema.String;
    readonly input: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    /**
     * The resolved declaration's display projection, as its owner encoded it.
     *
     * JSON rather than a struct because the vocabulary belongs to
     * `@smthrs/registry` (`Descriptor.FlowActivity`, `Descriptor.CallPresentation`),
     * which sits above this package: `@smthrs/harness` `Cell.displayDescriptor`
     * encodes it from a typed call and the reading card validates each field
     * before it is displayed, so the journal carries it and claims nothing about
     * it. Absent means the declaration claimed nothing.
     */
    readonly descriptor: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
}>;
/** Decoded authorized call coordinates.
 * @category models
 * @since 1.0.0
 */
export type Call = typeof Call.Type;
declare const Annotation_base: Context.ServiceClass<Annotation, "@smthrs/journal/CallFact/Annotation", {
    readonly phase: "invoked" | "settled";
    readonly call: Call;
}>;
/** Native action annotation; only the existing controller record settles a call.
 * @category services
 * @since 1.0.0
 */
export declare class Annotation extends Annotation_base {
}
/** Public result vocabulary. Executable outcomes remain in the protected attempt row.
 * @category schemas
 * @since 1.0.0
 */
export declare const Result: Schema.Union<readonly [Schema.Struct<{
    readonly outcome: Schema.Literal<"success">;
    readonly value: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    readonly message: Schema.optional<Schema.String>;
    readonly code: Schema.optionalKey<Schema.Never>;
}>, Schema.Struct<{
    readonly outcome: Schema.Literal<"failure">;
    readonly value: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    readonly message: Schema.optional<Schema.String>;
    readonly code: Schema.optional<Schema.String>;
}>]>;
/** Bounded, redacted event projection; a truncation marker is still JSON.
 * @category schemas
 * @since 1.0.0
 */
export declare const Fact: Schema.Union<readonly [Schema.Struct<{
    readonly version: Schema.Literal<1>;
    readonly callId: Schema.String;
    readonly identity: Schema.Struct<{
        /** Public logical run identity, not an authentication session credential. */
        readonly runId: Schema.String;
        readonly frame: Schema.Int;
        readonly cell: Schema.String;
        readonly ordinal: Schema.Int;
        readonly declaration: Schema.String;
        readonly layers: Schema.$Array<Schema.String>;
    }>;
    readonly flowName: Schema.String;
    readonly phase: Schema.Literal<"invoked">;
    readonly input: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    readonly descriptor: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
}>, Schema.Struct<{
    readonly version: Schema.Literal<1>;
    readonly callId: Schema.String;
    readonly identity: Schema.Struct<{
        /** Public logical run identity, not an authentication session credential. */
        readonly runId: Schema.String;
        readonly frame: Schema.Int;
        readonly cell: Schema.String;
        readonly ordinal: Schema.Int;
        readonly declaration: Schema.String;
        readonly layers: Schema.$Array<Schema.String>;
    }>;
    readonly flowName: Schema.String;
    readonly phase: Schema.Literal<"settled">;
    readonly outcome: Schema.Literals<readonly ["success", "failure"]>;
    readonly value: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    readonly message: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    readonly code: Schema.optional<Schema.String>;
}>]>;
/** Decoded public native call fact.
 * @category models
 * @since 1.0.0
 */
export type Fact = typeof Fact.Type;
/** The immutable native journal is the durable outbox consumed by the native bridge.
 * @category events
 * @since 1.0.0
 */
export declare const eventType = "flows.harness.call-fact.v1";
export {};
