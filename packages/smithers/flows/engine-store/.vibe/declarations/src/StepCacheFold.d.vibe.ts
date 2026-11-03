/**
 * The step-cache fold: `flows_step_cache` heads rebuilt from the journal.
 *
 * A head exists only because a `CacheStore.put` inserted it, and
 * `ActionPersistence` journals exactly that insertion as a
 * `flows.engine.cache-provenance` entry with action `admitted`, in the same
 * `journal.transact` as the `put`. A duplicate or a losing first-writer race
 * writes a ledger row but no head, so it journals no `admitted` entry. Every
 * engine eviction is journalled before the fenced `CacheStore.evict` that
 * performs it: `expired`, `stale_read_set`, and `replay_failed` with reason
 * `corruption`, each naming the row it retires. The fold retires a row on any
 * `replay_failed` that names it: a producer slot keeps the first reason it
 * journalled, so a corruption can hide behind an earlier host failure. A row
 * whose replay failed only on the host is then a miss.
 *
 * The fold keeps the admitted rows no eviction retired. A key with one such
 * row gets it back as its head. A key with several lost at least one of them
 * without a journal entry (`sweepExpired`, retention, an unfenced `evict`), and
 * the journal cannot say which one the store still held, so it gets no head.
 *
 * Cache results stay in the append-only `flows_step_cache_recorded` ledger
 * that the `admitted` entry addresses. The journal is redacted and replayed to
 * sync subscribers, so it carries the decision and the provenance, never the
 * executable result (issue #72).
 *
 * A rebuild writes a subset of the live heads, apart from rows removed without
 * a journal entry, whose restored hits still pass the engine's age, read-set,
 * and digest checks. Shared-tier write-backs have no local entry and are not
 * rebuilt. Compaction and rewind delete eviction entries, so a store holding
 * a compacted run, or one where any run was ever rewound, gets no heads at all.
 * Retention is not yet covered: it deletes a run's entries, and with them the
 * compaction floor and any eviction that run journalled of another run's row,
 * so a rebuild after retention can restore a row the engine evicted (issue
 * #2053). A convergence re-record that reuses an evicted row's provenance stays
 * retired, so that key misses.
 *
 * @since 1.0.0
 */
import { Journal, type JournalEvent, Projection } from "@smthrs/journal";
import { CacheStore } from "@smthrs/step-cache";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * The journal event type the fold reads.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const eventType = "flows.engine.cache-provenance";
/**
 * Provenance actions that retire the row they name.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const retiringActions: ReadonlyArray<string>;
/**
 * Admitted rows folded so far, and the ones the journal retired.
 *
 * @category models
 * @since 1.0.0
 */
export interface State {
    /** Every row a `put` inserted as a head, by {@link refId}. */
    readonly admitted: HashMap.HashMap<string, CacheStore.RecordedRef>;
    /** Rows an engine eviction retired, by {@link refId}. */
    readonly retired: HashSet.HashSet<string>;
}
/**
 * The stable identity of a recorded row.
 *
 * @category models
 * @since 1.0.0
 */
export declare const refId: (ref: CacheStore.RecordedRef) => string;
/**
 * Folds one committed journal entry.
 *
 * @category folds
 * @since 1.0.0
 */
export declare const reduce: (state: State, entry: JournalEvent.Entry) => State;
/**
 * The empty fold.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const initial: State;
/**
 * The fold as a journal projection, for `Journal.project` over one run.
 *
 * @category folds
 * @since 1.0.0
 */
export declare const projection: Projection.Projection<State>;
/**
 * The head each key may be rebuilt with: its one admitted row no eviction
 * retired. A key with more than one such row gets none.
 *
 * @category folds
 * @since 1.0.0
 */
export declare const candidates: (state: State) => ReadonlyArray<CacheStore.RecordedRef>;
/**
 * What a {@link rebuild} read and wrote.
 *
 * @category models
 * @since 1.0.0
 */
export interface Rebuilt {
    /** Runs with cache provenance entries. */
    readonly runs: number;
    /** Runs with a compaction floor. Any makes the rebuild write no heads. */
    readonly compacted: number;
    /** Runs a rewind truncated. Any makes the rebuild write no heads. */
    readonly rewound: number;
    readonly admitted: number;
    readonly retired: number;
    readonly heads: number;
}
/**
 * Rebuilds every `flows_step_cache` head from the journal.
 *
 * Reads each run's cache provenance entries in sequence order, folds them,
 * and replaces the heads through `CacheStore.rebuildHeads` in one writer
 * transaction. A store with a compacted or rewound run clears the heads
 * instead: the eviction that retired a row may be gone. A journal read failure, including
 * a compaction that lands during the read, leaves the heads untouched.
 *
 * Run it on a quiescent store, as a restore does: a cache write that commits
 * between the journal read and the rewrite is dropped from the heads (a miss,
 * never a wrong hit).
 *
 * @category operations
 * @since 1.0.0
 */
export declare const rebuild: () => Effect.Effect<{
    runs: number;
    compacted: number;
    rewound: number;
    admitted: number;
    retired: number;
    heads: number;
}, CacheStore.CacheStoreError | Journal.JournalError | import("effect/sql/SqlError").SqlError, import("@smthrs/database/DurableWriter").DurableWriter | Journal.Journal | SqlClient.SqlClient>;
