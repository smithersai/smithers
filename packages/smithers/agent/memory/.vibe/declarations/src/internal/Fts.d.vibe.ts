/**
 * Lazy SQLite full-text search operations.
 *
 * @see https://memory.smithers.sh/reference/api/
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import type { Fragment, Statement } from "effect/sql/Statement";
import type { DatabaseService } from "../Database.vibe";
import type { Kind } from "../Namespace.vibe";
/**
 * A record projected into a namespace-kind FTS table.
 *
 * @category models
 * @since 0.1.0
 */
export interface FtsRecord {
    readonly recordId: string;
    readonly recordKind: "fact" | "note";
    readonly namespaceId: string;
    readonly key: string;
    readonly text: string;
}
/**
 * Raw rank row returned by SQLite FTS5.
 *
 * @category models
 * @since 0.1.0
 */
export interface FtsMatch {
    readonly record_id: string;
    readonly record_kind: "fact" | "note";
    readonly rank: number;
}
/**
 * The PostgreSQL generated search column of a namespace-kind FTS table.
 *
 * @category migrations
 * @since 1.0.0
 */
export declare const postgresSearchColumn: (sql: SqlClient.SqlClient) => Fragment;
/**
 * The PostgreSQL search index of a namespace-kind FTS table.
 *
 * @category migrations
 * @since 1.0.0
 */
export declare const postgresSearchIndex: (sql: SqlClient.SqlClient, kind: Kind) => Statement<unknown>;
/**
 * Returns whether a namespace kind has opted into FTS5.
 *
 * @category queries
 * @since 0.1.0
 */
export declare const isFtsEnabled: (database: DatabaseService, kind: Kind) => Effect.Effect<boolean, SqlError.SqlError>;
/**
 * Creates and fully backfills one namespace-kind FTS5 table.
 *
 * A kind that `memory_fts_kinds` already holds is left alone: its projection
 * has been maintained row by row since it was enabled, so a second call at
 * setup time does not rebuild it under the writer. The fact backfill is one
 * `INSERT ... SELECT` that derives the searchable text in SQL the same way
 * `searchableText` does: a string value is the string, an object with a
 * string `content` is that content, anything else is its JSON text.
 *
 * This Effect must be run inside `Database.write`.
 *
 * @category migrations
 * @since 0.1.0
 */
export declare const enableFts: (database: DatabaseService, kind: Kind, enabledAtMs: number) => Effect.Effect<void, SqlError.SqlError>;
/**
 * Deletes the FTS projections of many facts of one namespace and kind when the
 * kind is enabled, with one statement instead of one per fact.
 *
 * @category projections
 * @since 1.0.0
 */
export declare const deleteFtsFacts: (database: DatabaseService, kind: Kind, namespaceId: string, factKeys: ReadonlyArray<string>) => Effect.Effect<void, SqlError.SqlError>;
/**
 * Replaces one authoritative record's FTS projection when its kind is enabled.
 *
 * This Effect must be run inside the authoritative record's
 * `Database.write` transaction.
 *
 * @category projections
 * @since 0.1.0
 */
export declare const replaceFtsRecord: (database: DatabaseService, kind: Kind, record: FtsRecord) => Effect.Effect<void, SqlError.SqlError>;
/**
 * Deletes one authoritative record's FTS projection when its kind is enabled.
 *
 * @category projections
 * @since 0.1.0
 */
export declare const deleteFtsRecord: (database: DatabaseService, kind: Kind, record: Pick<FtsRecord, "recordId" | "recordKind" | "namespaceId">) => Effect.Effect<void, SqlError.SqlError>;
/**
 * Searches one namespace-kind FTS5 table in raw BM25 rank order.
 *
 * `offset` lets a caller walk the ranked matches in pages. A match can be
 * dropped by a status, supersession, or tag filter the FTS table knows nothing
 * about, so returning the caller's page size in one shot would under-fill the
 * answer; paging is what lets the store keep asking until it has enough.
 *
 * @category queries
 * @since 0.1.0
 */
export declare const searchFts: (database: DatabaseService, kind: Kind, namespaceId: string, terms: ReadonlyArray<string>, limit: number, offset?: number) => Effect.Effect<ReadonlyArray<FtsMatch>, SqlError.SqlError>;
