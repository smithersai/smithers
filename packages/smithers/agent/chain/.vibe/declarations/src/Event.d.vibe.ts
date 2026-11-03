/**
 * The journal event vocabulary of a chain, and the pure folds over it.
 *
 * The journal is the only state. The call cache used for replay, the
 * observation context handed to recovery author calls, and the terminal
 * verdict are all pure folds over the event array — nothing else is stored
 * anywhere (https://chain.smithers.sh/contract/).
 *
 * @since 0.1.0
 */
import { Schema } from "effect";
import * as Observation from "./Observation.vibe";
import * as Outcome from "./Outcome.vibe";
import * as Script from "./Script.vibe";
/**
 * The chain's first event: the goal it was started with and the caller's
 * envelope.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const ChainStarted: Schema.TaggedStruct<"ChainStarted", {
    readonly chain: Schema.optional<Schema.String>;
    readonly goal: Schema.String;
    readonly envelope: Schema.Codec<Schema.Json, Schema.Json, never, never>;
}>;
/**
 * The decoded form of {@link ChainStarted}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ChainStarted = typeof ChainStarted.Type;
/**
 * The script a link will execute, recorded before it runs so a resumed link
 * replays the same source.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const LinkAuthored: Schema.TaggedStruct<"LinkAuthored", {
    readonly chain: Schema.optional<Schema.String>;
    readonly link: Schema.Int;
    readonly script: Schema.Struct<{
        readonly text: Schema.String;
        readonly digest: Schema.String;
    }>;
}>;
/**
 * The decoded form of {@link LinkAuthored}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type LinkAuthored = typeof LinkAuthored.Type;
/**
 * One call that reached an entry and produced a result — the unit the
 * replay cache is keyed by.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const CallSettled: Schema.TaggedStruct<"CallSettled", {
    readonly chain: Schema.optional<Schema.String>;
    readonly link: Schema.Int;
    readonly key: Schema.Struct<{
        readonly link: Schema.Int;
        readonly scriptDigest: Schema.String;
        readonly ordinal: Schema.Int;
        readonly entryDigest: Schema.String;
    }>;
    readonly name: Schema.String;
    readonly payload: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    readonly result: Schema.Codec<Schema.Json, Schema.Json, never, never>;
}>;
/**
 * The decoded form of {@link CallSettled}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type CallSettled = typeof CallSettled.Type;
/**
 * One call a gate refused, recorded as the observation the next authoring
 * reads.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const GateRejected: Schema.TaggedStruct<"GateRejected", {
    readonly chain: Schema.optional<Schema.String>;
    readonly link: Schema.Int;
    readonly ordinal: Schema.Int;
    readonly observation: Schema.Struct<{
        readonly kind: Schema.Literals<readonly ["shape", "fuel", "catalog", "call_failed", "script_failed", "denied"]>;
        readonly message: Schema.String;
    }>;
}>;
/**
 * The decoded form of {@link GateRejected}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type GateRejected = typeof GateRejected.Type;
/**
 * The outcome a link ended with — the event that advances the link counter.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const LinkEnded: Schema.TaggedStruct<"LinkEnded", {
    readonly chain: Schema.optional<Schema.String>;
    readonly link: Schema.Int;
    readonly outcome: Schema.Union<readonly [Schema.TaggedStruct<"Done", {
        readonly value: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    }>, Schema.TaggedStruct<"To", {
        readonly script: Schema.Struct<{
            readonly text: Schema.String;
            readonly digest: Schema.String;
        }>;
    }>, Schema.TaggedStruct<"Park", {
        readonly reason: Schema.Struct<{
            readonly code: Schema.Literals<readonly ["approval", "event", "timer", "quota", "plugin"]>;
            readonly message: Schema.String;
        }>;
    }>]>;
}>;
/**
 * The decoded form of {@link LinkEnded}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type LinkEnded = typeof LinkEnded.Type;
/**
 * One non-empty steering drain, tied to the live author call it fed —
 * a nondeterministic boundary in the sense of `RecordBoundary`
 * (packages/smithers/agent/harness/src/EngineLike.ts), journaled so a re-executed attempt reuses the recorded lines. Empty
 * drains are not journaled: a settled author call already pins its
 * context in its `CallSettled` payload.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const SteeringDrained: Schema.TaggedStruct<"SteeringDrained", {
    readonly chain: Schema.optional<Schema.String>;
    readonly link: Schema.Int;
    readonly ordinal: Schema.Int;
    readonly messages: Schema.$Array<Schema.String>;
}>;
/**
 * The decoded form of {@link SteeringDrained}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type SteeringDrained = typeof SteeringDrained.Type;
/**
 * Every event a chain can journal.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const Event: Schema.Union<readonly [Schema.TaggedStruct<"ChainStarted", {
    readonly chain: Schema.optional<Schema.String>;
    readonly goal: Schema.String;
    readonly envelope: Schema.Codec<Schema.Json, Schema.Json, never, never>;
}>, Schema.TaggedStruct<"LinkAuthored", {
    readonly chain: Schema.optional<Schema.String>;
    readonly link: Schema.Int;
    readonly script: Schema.Struct<{
        readonly text: Schema.String;
        readonly digest: Schema.String;
    }>;
}>, Schema.TaggedStruct<"CallSettled", {
    readonly chain: Schema.optional<Schema.String>;
    readonly link: Schema.Int;
    readonly key: Schema.Struct<{
        readonly link: Schema.Int;
        readonly scriptDigest: Schema.String;
        readonly ordinal: Schema.Int;
        readonly entryDigest: Schema.String;
    }>;
    readonly name: Schema.String;
    readonly payload: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    readonly result: Schema.Codec<Schema.Json, Schema.Json, never, never>;
}>, Schema.TaggedStruct<"GateRejected", {
    readonly chain: Schema.optional<Schema.String>;
    readonly link: Schema.Int;
    readonly ordinal: Schema.Int;
    readonly observation: Schema.Struct<{
        readonly kind: Schema.Literals<readonly ["shape", "fuel", "catalog", "call_failed", "script_failed", "denied"]>;
        readonly message: Schema.String;
    }>;
}>, Schema.TaggedStruct<"LinkEnded", {
    readonly chain: Schema.optional<Schema.String>;
    readonly link: Schema.Int;
    readonly outcome: Schema.Union<readonly [Schema.TaggedStruct<"Done", {
        readonly value: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    }>, Schema.TaggedStruct<"To", {
        readonly script: Schema.Struct<{
            readonly text: Schema.String;
            readonly digest: Schema.String;
        }>;
    }>, Schema.TaggedStruct<"Park", {
        readonly reason: Schema.Struct<{
            readonly code: Schema.Literals<readonly ["approval", "event", "timer", "quota", "plugin"]>;
            readonly message: Schema.String;
        }>;
    }>]>;
}>, Schema.TaggedStruct<"SteeringDrained", {
    readonly chain: Schema.optional<Schema.String>;
    readonly link: Schema.Int;
    readonly ordinal: Schema.Int;
    readonly messages: Schema.$Array<Schema.String>;
}>]>;
/**
 * The decoded form of {@link Event}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Event = typeof Event.Type;
/**
 * Whether an event belongs to the given chain scope.
 *
 * @category folds
 * @since 0.1.0
 * @slop
 */
export declare const inChain: (event: Event, chain: string) => boolean;
/**
 * Whether the chain has recorded its `ChainStarted` event.
 *
 * @category folds
 * @since 0.1.0
 * @slop
 */
export declare const started: (events: ReadonlyArray<Event>, chain?: string) => boolean;
/**
 * The index of the current link: links end strictly in order, so the count
 * of `LinkEnded` events names the link now in progress.
 *
 * @category folds
 * @since 0.1.0
 * @slop
 */
export declare const linkCount: (events: ReadonlyArray<Event>, chain?: string) => number;
/**
 * The script authored for a link, if any. Link 0 (bootstrap) never has one.
 *
 * @category folds
 * @since 0.1.0
 * @slop
 */
export declare const authored: (events: ReadonlyArray<Event>, link: number, chain?: string) => Script.Script | undefined;
/**
 * The settled calls of a link, keyed by ordinal — the replay cache.
 *
 * @category folds
 * @since 0.1.0
 * @slop
 */
export declare const settled: (events: ReadonlyArray<Event>, link: number, chain?: string) => ReadonlyMap<number, CallSettled>;
/**
 * The gate rejections of a link, keyed by ordinal — replayed as aborts so a
 * resumed link never re-executes a rejected call.
 *
 * @category folds
 * @since 0.1.0
 * @slop
 */
export declare const rejected: (events: ReadonlyArray<Event>, link: number, chain?: string) => ReadonlyMap<number, GateRejected>;
/**
 * All observations recorded for a link, in journal order — the material a
 * recovery author call projects into its context.
 *
 * @category folds
 * @since 0.1.0
 * @slop
 */
export declare const observations: (events: ReadonlyArray<Event>, link: number, chain?: string) => ReadonlyArray<Observation.Observation>;
/**
 * Every steering line recorded for a link, in drain order. Steering is
 * link-cumulative: once drained into a link it reaches every subsequent
 * author attempt of that link, so a rejected attempt never swallows the
 * user's instruction.
 *
 * @category folds
 * @since 0.1.0
 * @slop
 */
export declare const steeringLines: (events: ReadonlyArray<Event>, link: number, chain?: string) => ReadonlyArray<string>;
/**
 * The ordinals of a link's recorded drains — a resumed execution never
 * re-drains a boundary it already consumed.
 *
 * @category folds
 * @since 0.1.0
 * @slop
 */
export declare const steeredOrdinals: (events: ReadonlyArray<Event>, link: number, chain?: string) => ReadonlySet<number>;
/**
 * The chain's terminal outcome, if it has one: the last `LinkEnded` whose
 * outcome is `Done` or `Park`. A replay of a finished chain returns this
 * without executing anything.
 *
 * @category folds
 * @since 0.1.0
 * @slop
 */
export declare const terminal: (events: ReadonlyArray<Event>, chain?: string) => Outcome.Terminal | undefined;
