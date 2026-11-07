import * as ReviewLoop from "@smthrs/patterns/ReviewLoop";
import * as Effect from "effect/Effect";
/**
 * Drafts a title, then revises it until the reviewer approves or two rounds
 * pass. The reviewer approves a title of at most 20 characters.
 */
export declare const reviewTitle: (draft: string) => Effect.Effect<ReviewLoop.Settled<string, {
    approved: boolean;
    length: number;
}>, import("../src/PatternError.vibe").PatternError, never>;
/**
 * Starts three checks at most two at a time, highest priority first, and
 * records the order they started in.
 */
export declare const rankedChecks: Effect.Effect<{
    results: Readonly<Record<string, string>>;
    order: readonly string[];
}, import("../src/PatternError.vibe").PatternError, never>;
/**
 * Runs three checks so a failed one is quarantined while its siblings still
 * finish, then settles the outcomes into values or one `quarantined` error
 * naming every failed check.
 */
export declare const checkRepositories: (broken: ReadonlyArray<string>) => Effect.Effect<Readonly<Record<string, string>>, import("../src/PatternError.vibe").PatternError, never>;
