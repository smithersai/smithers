import { type PatternError, Saga } from "@smthrs/patterns";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
declare const Rejected_base: Schema.Class<Rejected, Schema.TaggedStruct<"examples/Rejected", {
    readonly step: Schema.String;
}>, import("effect/Cause").YieldableError>;
/** The failure the deploy's third step raises. */
export declare class Rejected extends Rejected_base {
}
/** The deploy, declared. Nothing runs; this is the plan the operator reads. */
export declare const deployment: Saga.SagaFlow<never>;
/** Every call the declaration reaches, forward steps then compensations. */
export declare const declaredCalls: ReadonlyArray<string>;
/** What the release did, in the order it did it. */
export interface Summary {
    readonly checks: Readonly<Record<string, string>>;
    readonly quarantined: ReadonlyArray<string>;
    readonly fixedAt: number;
    readonly deploy: ReadonlyArray<string>;
    readonly outcome: string;
    readonly lockHeld: boolean;
}
/**
 * The failures this release can end in: a pattern's own declaration or runtime
 * failure, and the deploy's typed rejection.
 */
export type ReleaseError = PatternError.PatternError | Rejected;
/** Recovers a deploy rejection and releases its lock on every exit. */
export declare const protectRelease: <R, R2>(body: Effect.Effect<unknown, ReleaseError, R>, release: Effect.Effect<unknown, never, R2>) => Effect.Effect<string, PatternError.PatternError, R | R2>;
export declare function main(): Effect.Effect<Summary, ReleaseError>;
export {};
