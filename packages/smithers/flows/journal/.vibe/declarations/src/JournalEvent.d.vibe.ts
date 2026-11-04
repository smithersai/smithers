/**
 * Durable event-envelope schemas for the journal.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema";
/**
 * Longest identifier the journal persists.
 *
 * A run id, a source id and an event type are index columns of a permanent
 * table and are held in per-run maps for the layer's lifetime, so an
 * unbounded one costs durable index space and heap that nothing ever
 * reclaims. Every identifier this repository mints is a uuid or a short
 * dotted name, two orders of magnitude below this bound, so the ceiling
 * refuses only the shapes that were never identifiers.
 *
 * @since 1.0.0
 * @category constants
 */
export declare const maxIdentifierLength = 1024;
/**
 * Schema for an identifier of one durable run.
 *
 * Between 1 and 1,024 UTF-16 code units, free of unpaired UTF-16 surrogates
 * because the store cannot tell two ill-formed identifiers apart, and free of
 * NUL because the store's own length check cannot see past one.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const RunId: Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/RunId">;
/**
 * Branded identifier of one durable run.
 *
 * @category models
 * @since 0.1.0
 */
export type RunId = typeof RunId.Type;
/**
 * Schema for the canonical, durable sequence number within a run.
 *
 * `Number.MAX_SAFE_INTEGER` is excluded because the journal must always be
 * able to allocate the next sequence. `Number.MAX_SAFE_INTEGER + 1` is not a
 * distinct integer, so the maximum is not an allocatable sequence.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Seq: Schema.brand<Schema.Int, "@smthrs/journal/JournalEvent/Seq">;
/**
 * Canonical durable per-run sequence number.
 *
 * @category models
 * @since 0.1.0
 */
export type Seq = typeof Seq.Type;
/**
 * Schema for an event producer identifier.
 *
 * The same shape `RunId` accepts, on the same terms: the pair identifies a
 * producer's retries in the database.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const SourceId: Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/SourceId">;
/**
 * Identifier of an event producer.
 *
 * @category models
 * @since 0.1.0
 */
export type SourceId = typeof SourceId.Type;
/**
 * Schema for a producer-local event sequence number.
 *
 * `Number.MAX_SAFE_INTEGER` is excluded because the journal must always be
 * able to allocate the next sequence. `Number.MAX_SAFE_INTEGER + 1` is not a
 * distinct integer, so the maximum is not an allocatable sequence.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const SourceSeq: Schema.brand<Schema.Int, "@smthrs/journal/JournalEvent/SourceSeq">;
/**
 * Producer-local event sequence number.
 *
 * @category models
 * @since 0.1.0
 */
export type SourceSeq = typeof SourceSeq.Type;
/**
 * Schema for what a re-emitted `(runId, sourceId, sourceSeq)` identity means.
 *
 * `content` is the default and the strict reading: the identity names one set
 * of bytes, so a producer that re-emits it with different bytes has a bug and
 * the journal says so with `idempotency_conflict`.
 *
 * `identity` is for a producer that derives the sequence from the event
 * itself. There a collision IS the same event observed twice, and the bytes
 * that differ between the two observations are metadata ABOUT the observation
 * rather than the event: when a replayed frame was re-recorded, how long a
 * step took the second time a durable engine served it from its record. The
 * first admitted row stands and the re-emission settles as `Duplicate`. Only
 * declare it with a sequence derived from the event's own content, because
 * the journal then has nothing else with which to notice two different events
 * wearing one identity.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Dedupe: Schema.Literals<readonly ["content", "identity"]>;
/**
 * What a re-emitted producer identity means.
 *
 * @category models
 * @since 0.1.0
 */
export type Dedupe = typeof Dedupe.Type;
declare const Input_base: Schema.Class<Input, Schema.Struct<{
    readonly runId: Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/RunId">;
    readonly sourceId: Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/SourceId">;
    readonly sourceSeq: Schema.optional<Schema.brand<Schema.Int, "@smthrs/journal/JournalEvent/SourceSeq">>;
    /** How a collision on this event's identity is settled. Defaults to `content`. */
    readonly dedupe: Schema.optional<Schema.Literals<readonly ["content", "identity"]>>;
    /** Non-empty, NUL-free, well-formed UTF-16 of at most 1,024 code units. */
    readonly eventType: Schema.String;
    readonly payload: Schema.Unknown;
    readonly meta: Schema.optional<Schema.Unknown>;
}>, {}>;
/**
 * Schema for an event submitted to the journal.
 *
 * Event types and values intentionally remain an open envelope. The durable
 * core never closes this into an interpreter-specific union.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare class Input extends Input_base {
}
declare const Entry_base: Schema.Class<Entry, Schema.Struct<{
    readonly runId: Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/RunId">;
    readonly seq: Schema.brand<Schema.Int, "@smthrs/journal/JournalEvent/Seq">;
    /**
     * Derived by {@link makeEventId} from the other three identity members, never
     * supplied by a caller, so it carries no check of its own.
     */
    readonly eventId: Schema.String;
    readonly sourceId: Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/SourceId">;
    readonly sourceSeq: Schema.brand<Schema.Int, "@smthrs/journal/JournalEvent/SourceSeq">;
    readonly emittedAtMs: Schema.Int;
    /**
     * The same bounded identifier `Input.eventType` accepts. It used to be a bare
     * `Schema.String` here, so a consumer decoding an `Entry` accepted an empty,
     * over-long, NUL-bearing, or ill-formed-UTF-16 event type that no emit could
     * ever have produced.
     */
    readonly eventType: Schema.String;
    readonly payload: Schema.Unknown;
    readonly meta: Schema.Unknown;
}>, {}>;
/**
 * Schema for a committed durable journal row.
 *
 * `seq` is allocated synchronously at journal admission and is the only
 * sequence used for replay and durable provenance. `sourceSeq` identifies
 * retries from one producer.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare class Entry extends Entry_base {
}
/**
 * Makes a collision-free deterministic event identifier from the idempotency
 * key `(runId, sourceId, sourceSeq)`.
 *
 * Length prefixes preserve tuple boundaries even when identifiers contain the
 * separator. The value is deliberately not random: retrying the same source
 * event must produce the same durable id.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const makeEventId: (runId: RunId, sourceId: SourceId, sourceSeq: SourceSeq) => string;
/**
 * The reserved prefix of every companion stream id.
 *
 * A run id that begins with it names a companion stream, never a run: stores
 * that admit run ids (`@smthrs/run-store`'s `RunStore.create`) refuse it.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const companionPrefix = "flows.companion/";
/**
 * The digest a journal fact uses to reference bytes kept outside the journal:
 * the SHA-256 of the UTF-8 encoding of `text`, as 64 lowercase hex digits.
 *
 * The journal redacts every payload, so a fact never carries executable
 * values. A store that folds state from its facts keeps the bytes in its own
 * rows and records only their digest, which a rebuild checks the row against.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const contentDigest: (text: string) => string;
/**
 * The id of the companion stream that carries one store's facts about a run.
 *
 * A companion stream is an ordinary journal stream with its own sequence
 * clock, kept beside the run's own stream rather than inside it. A consumer
 * that reads the run's stream by position never sees a companion fact, and a
 * rewind or compaction of the run's stream never truncates one. The id is
 * `flows.companion/<stream>/<sha-256 of the run id>`, so it stays within
 * {@link maxIdentifierLength} for every run id; each fact carries its run id
 * in its payload.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const companionRunId: (stream: string, runId: string) => RunId;
/**
 * Whether a run id names a companion stream.
 *
 * @category predicates
 * @since 1.0.0
 */
export declare const isCompanionRunId: (runId: string) => boolean;
/**
 * Bounded durable text shared by namespace contracts.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Identifier: Schema.String;
/**
 * A lineage coordinate, distinct from the run that currently hosts it.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const LineageId: Schema.brand<Schema.String, "@smthrs/journal/LineageId">;
/**
 * A lineage coordinate.
 *
 * @category models
 * @since 1.0.0
 */
export type LineageId = typeof LineageId.Type;
/**
 * A concrete wait identity.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const WaitId: Schema.brand<Schema.String, "@smthrs/journal/WaitId">;
/**
 * A concrete wait identity.
 *
 * @category models
 * @since 1.0.0
 */
export type WaitId = typeof WaitId.Type;
/**
 * An admitted command identity.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const CommandId: Schema.brand<Schema.String, "@smthrs/journal/CommandId">;
/**
 * An admitted command identity.
 *
 * @category models
 * @since 1.0.0
 */
export type CommandId = typeof CommandId.Type;
/**
 * A plan identity, never interchangeable with a dispatch or artifact.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const PlanId: Schema.brand<Schema.String, "@smthrs/journal/PlanId">;
/**
 * A plan identity.
 *
 * @category models
 * @since 1.0.0
 */
export type PlanId = typeof PlanId.Type;
/**
 * A dispatch identity. Branding does not verify its digest.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const DispatchId: Schema.brand<Schema.String, "@smthrs/journal/DispatchId">;
/**
 * A dispatch identity.
 *
 * @category models
 * @since 1.0.0
 */
export type DispatchId = typeof DispatchId.Type;
/**
 * An artifact identity. Branding does not verify content.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const ArtifactId: Schema.brand<Schema.String, "@smthrs/journal/ArtifactId">;
/**
 * An artifact identity.
 *
 * @category models
 * @since 1.0.0
 */
export type ArtifactId = typeof ArtifactId.Type;
/**
 * Integer quantities in the inclusive safe range, including zero.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const NonNegativeQuantity: Schema.Int;
/**
 * Integer quantities in the inclusive safe range, excluding zero.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const PositiveQuantity: Schema.Int;
/**
 * Non-negative integral milliseconds since the Unix epoch.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const TimestampMs: Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">;
/**
 * Non-negative integral milliseconds since the Unix epoch.
 *
 * @category models
 * @since 1.0.0
 */
export type TimestampMs = typeof TimestampMs.Type;
/**
 * Decode a run id without a cast; schema failures retain their issue.
 *
 * @category decoders
 * @since 1.0.0
 */
export declare const decodeRunId: (input: unknown, options?: import("effect/SchemaAST").ParseOptions) => import("effect/Effect").Effect<string & import("effect/Brand").Brand<"@smthrs/journal/JournalEvent/RunId">, Schema.SchemaError, never>;
/**
 * Decode a lineage id without a cast.
 *
 * @category decoders
 * @since 1.0.0
 */
export declare const decodeLineageId: (input: unknown, options?: import("effect/SchemaAST").ParseOptions) => import("effect/Effect").Effect<string & import("effect/Brand").Brand<"@smthrs/journal/LineageId">, Schema.SchemaError, never>;
/**
 * Decode a wait id without a cast.
 *
 * @category decoders
 * @since 1.0.0
 */
export declare const decodeWaitId: (input: unknown, options?: import("effect/SchemaAST").ParseOptions) => import("effect/Effect").Effect<string & import("effect/Brand").Brand<"@smthrs/journal/WaitId">, Schema.SchemaError, never>;
/**
 * Decode a command id without a cast.
 *
 * @category decoders
 * @since 1.0.0
 */
export declare const decodeCommandId: (input: unknown, options?: import("effect/SchemaAST").ParseOptions) => import("effect/Effect").Effect<string & import("effect/Brand").Brand<"@smthrs/journal/CommandId">, Schema.SchemaError, never>;
/**
 * Decode a plan id without a cast.
 *
 * @category decoders
 * @since 1.0.0
 */
export declare const decodePlanId: (input: unknown, options?: import("effect/SchemaAST").ParseOptions) => import("effect/Effect").Effect<string & import("effect/Brand").Brand<"@smthrs/journal/PlanId">, Schema.SchemaError, never>;
/**
 * Decode a dispatch id without a cast.
 *
 * @category decoders
 * @since 1.0.0
 */
export declare const decodeDispatchId: (input: unknown, options?: import("effect/SchemaAST").ParseOptions) => import("effect/Effect").Effect<string & import("effect/Brand").Brand<"@smthrs/journal/DispatchId">, Schema.SchemaError, never>;
/**
 * Decode an artifact id without a cast.
 *
 * @category decoders
 * @since 1.0.0
 */
export declare const decodeArtifactId: (input: unknown, options?: import("effect/SchemaAST").ParseOptions) => import("effect/Effect").Effect<string & import("effect/Brand").Brand<"@smthrs/journal/ArtifactId">, Schema.SchemaError, never>;
/**
 * Decode an absolute timestamp without coercion.
 *
 * @category decoders
 * @since 1.0.0
 */
export declare const decodeTimestampMs: (input: unknown, options?: import("effect/SchemaAST").ParseOptions) => import("effect/Effect").Effect<number & import("effect/Brand").Brand<"@smthrs/journal/TimestampMs">, Schema.SchemaError, never>;
/**
 * Decode a budget that permits zero. Units belong to the field.
 *
 * @category decoders
 * @since 1.0.0
 */
export declare const decodeNonNegativeQuantity: (input: unknown, options?: import("effect/SchemaAST").ParseOptions) => import("effect/Effect").Effect<number, Schema.SchemaError, never>;
/**
 * Decode a budget that requires positive capacity.
 *
 * @category decoders
 * @since 1.0.0
 */
export declare const decodePositiveQuantity: (input: unknown, options?: import("effect/SchemaAST").ParseOptions) => import("effect/Effect").Effect<number, Schema.SchemaError, never>;
export {};
