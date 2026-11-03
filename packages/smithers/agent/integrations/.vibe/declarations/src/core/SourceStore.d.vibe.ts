/**
 * Durable storage and authorized retrieval for source records.
 *
 * Every record an integration retrieves lands here, keyed by its connection
 * and external id. Four properties are the reason this is a store rather than
 * a table anyone writes:
 *
 * - **Monotonic apply.** A copy replaces the stored one only when
 *   `SourceRecord.supersedes` says it is newer, so duplicates are no-ops and
 *   edits delivered out of order converge on the newest copy. At an equal
 *   change time, deletion and version, a copy retrieved later whose content
 *   differs replaces the stored one: a provider that edits an object twice
 *   within its clock's resolution still ends up with the second edit.
 * - **Tombstones and revocation purge content.** A deleted record keeps its
 *   identity, placement, times and version, and loses its text, payload,
 *   author and link. Revoking a connection or one container of it does the
 *   same to every record there and leaves a revocation marker, so a sync that
 *   races the revocation stores metadata only. `reinstate` removes a marker;
 *   purged records return when a sync lists them again. A deletion a full
 *   listing inferred from absence yields the same way: a later copy at least as
 *   new as the one it removed restores the record.
 * - **Authorization before text.** `retrieve` takes the grants the caller
 *   holds and filters on them, and on deletion and revocation, inside the
 *   query: the text of a record the caller may not read never leaves the
 *   database. A record is readable through a grant for its connection that
 *   covers every container it lives in (`SourceRecord.containers`); a record in
 *   no container needs the connection-wide `*`.
 * - **One transaction per sync page.** `commit` applies a page of changes,
 *   runs the mark-and-sweep a fresh full listing needs, and advances the
 *   stream's cursor in `smithers_integration_cursors` together, so a crash
 *   leaves either all of it or none of it.
 *
 * `validate` answers, for references a run kept, whether each is still the
 * readable copy it used, so a resumed run refuses revoked or deleted context
 * explicitly instead of reusing a stale snapshot.
 *
 * The SQL store requires `Core.Migrations` to have run.
 *
 * @since 1.0.0
 */
import { DurableWriter } from "@smthrs/database/DurableWriter";
import { Context, Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { IntegrationError } from "../../../../src/core/IntegrationError.ts";
import * as SourceRecord from "./SourceRecord.vibe";
import type { Changes } from "./Sync.vibe";
/**
 * The container id a grant uses to cover a whole connection, and the
 * revocation marker for a whole connection.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const WILDCARD = "*";
/**
 * The most records one `retrieve` returns.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const MAX_RETRIEVE_LIMIT = 500;
/**
 * What a caller may read of one connection: the containers it is granted, or
 * `["*"]` for all of them. An empty list reads nothing.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Grant: Schema.Struct<{
    readonly connectionId: Schema.NonEmptyString;
    readonly containers: Schema.$Array<Schema.NonEmptyString>;
}>;
/**
 * What a caller may read of one connection.
 *
 * @category models
 * @since 1.0.0
 */
export type Grant = typeof Grant.Type;
/**
 * Whether one of `allowed` covers `record`: a grant for its connection that
 * is connection-wide, or that names every container the record lives in.
 *
 * @category authorization
 * @since 1.0.0
 */
export declare const covers: (allowed: ReadonlyArray<Grant>, record: Pick<SourceRecord.SourceRecord, "connectionId" | "access" | "thread">) => boolean;
/**
 * One stored record, as the store holds it.
 *
 * `record` is purged (no text, payload, author or link) when it is deleted or
 * revoked. `stream` is the sync stream that last listed it, or `null` for a
 * record that only ever arrived through `apply`.
 *
 * @category models
 * @since 1.0.0
 */
export interface Stored {
    readonly record: SourceRecord.SourceRecord;
    readonly revoked: boolean;
    readonly stream: string | null;
}
/**
 * What a `retrieve` asks for.
 *
 * @category models
 * @since 1.0.0
 */
export interface Query {
    /** The grants the reader holds. Nothing outside them is returned. */
    readonly allowed: ReadonlyArray<Grant>;
    /** Case-insensitive (ASCII) substring of the record text. */
    readonly query?: string | undefined;
    /** Only these kinds. An empty list selects nothing. */
    readonly kinds?: ReadonlyArray<string> | undefined;
    /**
     * At most this many records, newest first by change time, or creation time
     * for a provider without one; 1 to {@link MAX_RETRIEVE_LIMIT}.
     */
    readonly limit: number;
}
/**
 * Whether a kept reference is still usable.
 *
 * `current` is the only usable answer: the record is readable by the caller
 * and is the copy the reference names. `changed` means readable but edited
 * since; `deleted`, `revoked`, `denied` (no grant covers it now) and
 * `missing` are refusals.
 *
 * @category models
 * @since 1.0.0
 */
export type Validity = "current" | "changed" | "deleted" | "revoked" | "denied" | "missing";
/**
 * One reference's answer from `validate`.
 *
 * @category models
 * @since 1.0.0
 */
export interface Validation {
    readonly reference: SourceRecord.Reference;
    readonly validity: Validity;
}
/**
 * What one `apply` or page did.
 *
 * `tombstoned` counts the inserted and updated records that are deletions.
 *
 * @category models
 * @since 1.0.0
 */
export interface ApplyReport {
    readonly inserted: number;
    readonly updated: number;
    readonly unchanged: number;
    readonly tombstoned: number;
}
/**
 * One page of one stream's changes, as `commit` applies it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Page {
    readonly provider: string;
    readonly connectionId: string;
    readonly stream: string;
    readonly changes: Changes;
}
/**
 * What one committed page did, including the sweep a completed full listing
 * ran.
 *
 * @category models
 * @since 1.0.0
 */
export interface CommitReport extends ApplyReport {
    /** Records the completed full listing did not contain, now tombstones. */
    readonly swept: number;
    /** Whether a full listing is still in progress after this page. */
    readonly sweeping: boolean;
}
/**
 * The store service.
 *
 * @category services
 * @since 1.0.0
 */
export interface SourceStore {
    /** Applies records monotonically in one transaction. */
    readonly apply: (records: ReadonlyArray<SourceRecord.SourceRecord>) => Effect.Effect<ApplyReport, IntegrationError>;
    /** The stored copy, unfiltered. Host code only: this is not an authorized read. */
    readonly get: (connectionId: string, externalId: string) => Effect.Effect<Option.Option<Stored>, IntegrationError>;
    /** Readable, live, unrevoked records the grants cover, filtered before any text is read. */
    readonly retrieve: (query: Query) => Effect.Effect<ReadonlyArray<SourceRecord.SourceRecord>, IntegrationError>;
    /** Whether each reference is still the readable copy it names. */
    readonly validate: (options: {
        readonly allowed: ReadonlyArray<Grant>;
        readonly references: ReadonlyArray<SourceRecord.Reference>;
    }) => Effect.Effect<ReadonlyArray<Validation>, IntegrationError>;
    /** Withdraws a connection: purges its records and refuses content from later syncs. Returns records purged. */
    readonly revokeConnection: (connectionId: string) => Effect.Effect<number, IntegrationError>;
    /** Withdraws one container of a connection. Returns records purged. */
    readonly revokeContainer: (connectionId: string, containerId: string) => Effect.Effect<number, IntegrationError>;
    /** Removes one revocation marker; `containerId` omitted removes the connection-wide one. */
    readonly reinstate: (connectionId: string, containerId?: string | undefined) => Effect.Effect<void, IntegrationError>;
    /** Whether the connection, or the named container of it, is revoked. */
    readonly isRevoked: (connectionId: string, containerId?: string | undefined) => Effect.Effect<boolean, IntegrationError>;
    /** The committed cursor of one stream, or `null` before its first page. */
    readonly cursor: (connectionId: string, stream: string) => Effect.Effect<string | null, IntegrationError>;
    /** Applies one page, sweeps a completed full listing, and advances the cursor, in one transaction. */
    readonly commit: (page: Page) => Effect.Effect<CommitReport, IntegrationError>;
}
/**
 * Service tag for the source record store.
 *
 * @category services
 * @since 1.0.0
 */
export declare const SourceStore: Context.Service<SourceStore, SourceStore>;
/**
 * The key a stream's cursor is stored under in the cursor table:
 * `connectionId:stream`. Connection ids carry no colon, so the key is
 * unambiguous.
 *
 * @category getters
 * @since 1.0.0
 */
export declare const cursorKey: (connectionId: string, stream: string) => string;
/**
 * An in-memory store with the same rules as the SQL one. Records live as long
 * as the process, which is what a test and an ephemeral host want.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const makeMemory: Effect.Effect<SourceStore>;
/**
 * Layer for the in-memory store.
 *
 * @category layers
 * @since 1.0.0
 */
export declare const layerMemory: Layer.Layer<SourceStore>;
/**
 * A store over the `smithers_integration_records` table and its companions,
 * sharing the database, and the cursor table, with `CursorStore.makeSql`.
 *
 * Requires `Core.Migrations` to have run. Writes go through the durable
 * writer, so each `apply`, `commit` and revocation is one serialized
 * transaction.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const makeSql: Effect.Effect<SourceStore, never, SqlClient.SqlClient | DurableWriter>;
/**
 * Layer for the SQL-backed store.
 *
 * @category layers
 * @since 1.0.0
 */
export declare const layerSql: Layer.Layer<SourceStore, never, SqlClient.SqlClient | DurableWriter>;
