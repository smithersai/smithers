/**
 * Row shapes, decoders, and validators shared by the memory store domains.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { MemoryError } from "../MemoryError.vibe";
import type { Fact, ListNotesInput, Note, NoteStatus, SearchRowsInput, Thread } from "../../../../src/MemoryStore.ts";
import * as Namespace from "../Namespace.vibe";
/**
 * A raw `memory_facts` row.
 *
 * @category models
 * @since 0.1.0
 */
export interface FactRow {
    readonly namespace_kind: Namespace.Kind;
    readonly namespace_id: string;
    readonly fact_key: string;
    readonly value_json: string;
    readonly tags_json: string | null;
    readonly ttl_ms: number | null;
    readonly provenance_json: string;
    readonly created_at_ms: number;
    readonly updated_at_ms: number;
}
/**
 * A raw `memory_messages` row.
 *
 * @category models
 * @since 0.1.0
 */
export interface MessageRow {
    readonly thread_id: string;
    readonly id: string;
    readonly role: string;
    readonly text: string;
    readonly at_ms: number;
}
/**
 * A raw `memory_threads` row.
 *
 * @category models
 * @since 0.1.0
 */
export interface ThreadRow {
    readonly thread_id: string;
    readonly namespace_kind: Namespace.Kind;
    readonly namespace_id: string;
    readonly title: string | null;
    readonly metadata_json: string | null;
    readonly created_at_ms: number;
    readonly updated_at_ms: number;
}
/**
 * A raw `memory_notes` row.
 *
 * @category models
 * @since 0.1.0
 */
export interface NoteRow {
    readonly namespace_kind: Namespace.Kind;
    readonly namespace_id: string;
    readonly id: string;
    readonly text: string;
    readonly tags_json: string;
    readonly provenance_json: string;
    readonly status: NoteStatus;
    readonly created_at_ms: number;
    readonly status_at_ms: number | null;
    readonly accepted_todo: string | null;
}
/**
 * A composable SQL condition. `effect/sql` publishes no entry point
 * for its `Statement` module, so the type is read back off `sql.literal`.
 *
 * @category models
 * @since 0.1.0
 */
export type Fragment = ReturnType<SqlClient.SqlClient["literal"]>;
/**
 * Builds a memory error with a bounded cause.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const error: (code: MemoryError["code"], message: string, cause?: unknown, path?: ReadonlyArray<string>) => MemoryError;
/**
 * Wraps a non-memory failure as a `store` error.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const storeError: (message: string) => (cause: unknown) => MemoryError;
/**
 * Reads the affected-row count from a raw driver result.
 *
 * @category utils
 * @since 0.1.0
 */
export declare const changed: (result: unknown) => number;
/**
 * Validates tags against the memory vocabulary and cap.
 *
 * @category validation
 * @since 0.1.0
 */
export declare const validateTags: (tags: Namespace.Tags) => Effect.Effect<Namespace.Tags, MemoryError>;
/**
 * Rejects an empty identifier.
 *
 * @category validation
 * @since 0.1.0
 */
export declare const validateNonEmpty: (value: string, field: string, path: ReadonlyArray<string>) => Effect.Effect<string, MemoryError>;
/**
 * Rejects a time that is not a non-negative safe integer.
 *
 * @category validation
 * @since 0.1.0
 */
export declare const validateTime: (value: number, field: string, path: ReadonlyArray<string>) => Effect.Effect<number, MemoryError>;
/**
 * Rejects a limit that is not a non-negative safe integer.
 *
 * @category validation
 * @since 0.1.0
 */
export declare const validateLimit: (value: number | undefined, operation: string) => Effect.Effect<number | undefined, MemoryError>;
/**
 * Encodes a value as JSON or fails `invalid_argument`.
 *
 * @category utils
 * @since 0.1.0
 */
export declare const encodeJson: (value: unknown, field: string, path: ReadonlyArray<string>) => Effect.Effect<string, MemoryError>;
/**
 * Decodes stored JSON or fails `store`.
 *
 * @category utils
 * @since 0.1.0
 */
export declare const decodeJson: (value: string, field: string) => Effect.Effect<unknown, MemoryError>;
/**
 * Decodes a fact row.
 *
 * @category utils
 * @since 0.1.0
 */
export declare const decodeFact: (row: FactRow) => Effect.Effect<Fact, MemoryError>;
/**
 * Decodes a note row.
 *
 * @category utils
 * @since 0.1.0
 */
export declare const decodeNote: (row: NoteRow) => Effect.Effect<Note, MemoryError>;
/**
 * Decodes a thread row.
 *
 * @category utils
 * @since 0.1.0
 */
export declare const decodeThread: (row: ThreadRow) => Effect.Effect<Thread, MemoryError>;
/**
 * Rows a tag-filtered note read pulls per round trip.
 *
 * A tag group is evaluated in JavaScript, so a bounded read pages until it has
 * `limit` matching rows instead of taking one oversized window. These two
 * numbers are the page, not the answer: they bound working-set memory and the
 * per-query cost, never how many rows the caller gets back.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const NOTE_PAGE_SIZE = 512;
/**
 * Smallest page a tag-filtered read pulls.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const MIN_NOTE_PAGE_SIZE = 128;
/**
 * Pages until `limit` kept rows or the source runs out.
 *
 * @category utils
 * @since 0.1.0
 */
export declare const collectUntil: <Row, A>(limit: number, pageSize: number, fetchPage: (pageSize: number, after: Row | undefined) => Effect.Effect<ReadonlyArray<Row>, MemoryError>, keep: (rows: ReadonlyArray<Row>) => Effect.Effect<ReadonlyArray<A>, MemoryError>) => Effect.Effect<ReadonlyArray<A>, MemoryError>;
/**
 * Builds the tag-group predicate of a read.
 *
 * @category utils
 * @since 0.1.0
 */
export declare const tagMatcher: (input: Pick<ListNotesInput, "tagGroups">) => (tags: ReadonlyArray<string>) => boolean;
/**
 * Validates exact search record identities.
 *
 * @category validation
 * @since 0.1.0
 */
export declare const validateRecords: (records: SearchRowsInput["records"], operation: "searchRows" | "searchFts") => Effect.Effect<undefined, MemoryError, never>;
