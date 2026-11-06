/**
 * Effect-valued assertions over a flow journal.
 *
 * @since 0.0.0
 */
import * as Effect from "effect/Effect";
import type { JournalEntryLike } from "./EngineSubject.vibe";
import { ExactlyOnceUnsupportedError, JournalAssertionError } from "./TestingError.vibe";
/**
 * A terminal outcome recorded by an engine journal.
 *
 * @category models
 * @since 0.0.0
 */
export type TerminalStatus = JournalEntryLike["outcome"];
/**
 * Fluent effect assertions for one journal.
 *
 * @category models
 * @since 0.0.0
 */
export interface JournalExpectations {
    readonly executed: (stepKey: string) => Effect.Effect<void, JournalAssertionError>;
    /**
     * Asserts the keys appear as a **subsequence** of the journal: every key in
     * turn, in this relative order, with any other entries allowed between and
     * around them. It is not a contiguous or an exhaustive match.
     */
    readonly executedInOrder: (keys: ReadonlyArray<string>) => Effect.Effect<void, JournalAssertionError>;
    /** Asserts the outcome of the entry with the highest `index`. */
    readonly terminal: (status: TerminalStatus) => Effect.Effect<void, JournalAssertionError>;
    /**
     * Assertions about the journaled external **effect** entries under `key`.
     * An ordinary step entry sharing the key never satisfies them: it fails with
     * `effect_kind_mismatch`.
     */
    readonly effect: (key: string) => EffectExpectations;
    /** The entries whose `index` is at most `untilIndex`, in index order. */
    readonly prefix: (untilIndex: number) => ReadonlyArray<JournalEntryLike>;
}
/**
 * Fluent effect assertions for one effect key in a journal.
 *
 * @category models
 * @since 0.0.0
 */
export interface EffectExpectations {
    readonly atLeastOnce: () => Effect.Effect<void, JournalAssertionError>;
    readonly journaledAtMostOnce: () => Effect.Effect<void, JournalAssertionError>;
    readonly idempotencyKey: (key: string) => Effect.Effect<void, JournalAssertionError>;
    /**
     * Always fails: an engine can prove at-least-once delivery and at-most-once
     * journaling, but it cannot prove exactly-once external effect execution.
     * Keeping this method deliberately failing prevents test vocabulary from
     * claiming a guarantee the engine does not provide.
     *
     * @since 0.0.0
     * @category assertions
     */
    readonly exactlyOnce: () => Effect.Effect<void, ExactlyOnceUnsupportedError>;
}
/**
 * Builds fluent, Effect-valued assertions over journal entries.
 *
 * Entries are read in `entry.index` order rather than in the order the caller
 * supplied them. `JournalEntryLike` carries an explicit `index` precisely
 * because ordering is data: an engine that reads its journal from a store with
 * no `ORDER BY`, or a caller that filtered and re-concatenated, hands over the
 * same entries in another order, and every assertion here must still answer
 * about the same entry.
 *
 * @category assertions
 * @since 0.0.0
 */
export declare const expectJournal: (unordered: ReadonlyArray<JournalEntryLike>) => JournalExpectations;
