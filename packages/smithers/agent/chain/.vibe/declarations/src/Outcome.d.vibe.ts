/**
 * The trampoline outcomes a link can end with.
 *
 * `done` completes the chain, `to` hands off to a successor script, and
 * `park` suspends the lineage with a typed waiting reason. There is no
 * agent-loop object: continuation is whatever the script returns
 * (https://chain.smithers.sh/contract/).
 *
 * @since 0.1.0
 */
import { Schema } from "effect";
import * as Script from "./Script.vibe";
/**
 * What a parked lineage is waiting for.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const ParkCode: Schema.Literals<readonly ["approval", "event", "timer", "quota", "plugin"]>;
/**
 * The decoded form of {@link ParkCode}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ParkCode = typeof ParkCode.Type;
/**
 * A park's typed code plus the prose a reader needs to act on it.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const ParkReason: Schema.Struct<{
    readonly code: Schema.Literals<readonly ["approval", "event", "timer", "quota", "plugin"]>;
    readonly message: Schema.String;
}>;
/**
 * The decoded form of {@link ParkReason}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ParkReason = typeof ParkReason.Type;
/**
 * The chain completed, carrying its result value.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const Done: Schema.TaggedStruct<"Done", {
    readonly value: Schema.Codec<Schema.Json, Schema.Json, never, never>;
}>;
/**
 * The decoded form of {@link Done}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Done = typeof Done.Type;
/**
 * The link hands off to a successor script — the trampoline's one bounce.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const To: Schema.TaggedStruct<"To", {
    readonly script: Schema.Struct<{
        readonly text: Schema.String;
        readonly digest: Schema.String;
    }>;
}>;
/**
 * The decoded form of {@link To}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type To = typeof To.Type;
/**
 * The lineage suspends, carrying the reason it is waiting.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const Park: Schema.TaggedStruct<"Park", {
    readonly reason: Schema.Struct<{
        readonly code: Schema.Literals<readonly ["approval", "event", "timer", "quota", "plugin"]>;
        readonly message: Schema.String;
    }>;
}>;
/**
 * The decoded form of {@link Park}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Park = typeof Park.Type;
/**
 * Every outcome a link can end with.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const Outcome: Schema.Union<readonly [Schema.TaggedStruct<"Done", {
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
/**
 * The decoded form of {@link Outcome}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Outcome = typeof Outcome.Type;
/**
 * A chain-ending outcome: parked lineages stop (wake is out of the slice's
 * scope) and completed lineages return their value.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Terminal = Done | Park;
/**
 * An unsettled approval boundary. This run result is never a script
 * outcome or a journal event; a grant and resume re-enter the same call.
 *
 * @category models
 * @since 0.1.0
 */
export interface ApprovalWait {
    readonly _tag: "ApprovalWait";
    readonly reason: {
        readonly code: "approval";
        readonly message: string;
    };
}
/**
 * A run either reaches a terminal outcome or waits at an unsettled call.
 * The persisted {@link Outcome} format contains only script outcomes.
 *
 * @category models
 * @since 0.1.0
 */
export type RunResult = Terminal | ApprovalWait;
/**
 * Completes the chain with a value; `undefined` becomes `null`, the one
 * JSON representation of "no value".
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const done: (value: typeof Schema.Json.Type) => Done;
/**
 * Continues the chain with a successor script.
 *
 * The digest is RE-DERIVED from the text and the caller's is discarded.
 * Scripts are model-authored and `to` is in their scope, so a script that
 * passed `{ text, digest }` through unchanged would choose its successor's
 * replay identity: two different texts could share one digest, and the
 * successor's calls would prefix-match a previous script's settled results
 * instead of re-keying. A script's digest is the digest of its text, always.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const to: (script: Script.Script) => To;
/**
 * Suspends the lineage with a typed waiting reason.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const park: (code: ParkCode, message?: string) => Park;
