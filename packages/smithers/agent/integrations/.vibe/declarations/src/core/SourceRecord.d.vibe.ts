/**
 * The provenance envelope for anything an integration retrieves.
 *
 * A message, a GitHub issue comment and an external event are different
 * documents, and this package keeps their provider payload exactly as it
 * arrived. What every one of them also needs, before it can be stored,
 * retrieved or placed in a prompt, is the same set of facts: which provider
 * and connection it came from, its stable external identity and link, who
 * wrote it and when, which version this is, when it was retrieved, who may
 * read it, and which thread it belongs to. `SourceRecord` is that set.
 *
 * `text` is the provider adapter's searchable rendering of the payload; it is
 * data, never instructions. `deleted` marks a tombstone: the provider removed
 * the object, so its payload and text are empty and retrieval never returns it.
 *
 * @since 1.0.0
 */
import { Schema } from "effect";
/**
 * Who may read a record, as the provider scoped it.
 *
 * `private` is one person's data (a direct message, a personal calendar),
 * `container` is visible to members of `access.containerId` (a channel, a
 * repository), `workspace` to every member of the connected workspace, and
 * `public` to anyone.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const AccessScope: Schema.Literals<readonly ["private", "container", "workspace", "public"]>;
/**
 * One of {@link AccessScope}'s values.
 *
 * @category models
 * @since 1.0.0
 */
export type AccessScope = typeof AccessScope.Type;
/**
 * The provider's author identity for a record.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Author: Schema.Struct<{
    /** The provider's stable user or bot id. */
    readonly id: Schema.NonEmptyString;
    /** A display label, when the provider supplied one. Never an identity. */
    readonly label: Schema.NullOr<Schema.String>;
}>;
/**
 * The provider's access scope for a record.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Access: Schema.Struct<{
    readonly scope: Schema.Literals<readonly ["private", "container", "workspace", "public"]>;
    /** The container the scope is relative to, or `null` when it names none. */
    readonly containerId: Schema.NullOr<Schema.NonEmptyString>;
}>;
/**
 * Where a record sits in its conversation or hierarchy.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Thread: Schema.Struct<{
    /** The channel, repository or calendar holding the record. */
    readonly containerId: Schema.NullOr<Schema.NonEmptyString>;
    /** The thread root's external id, or `null` outside a thread. */
    readonly threadId: Schema.NullOr<Schema.NonEmptyString>;
    /** The direct parent's external id (a comment's issue), or `null`. */
    readonly parentId: Schema.NullOr<Schema.NonEmptyString>;
}>;
/**
 * One retrieved provider object with its provenance.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const SourceRecord: Schema.Struct<{
    /** The provider that produced it: `github`. */
    readonly provider: Schema.NonEmptyString;
    /** The configured connection it was retrieved through. */
    readonly connectionId: Schema.NonEmptyString;
    /** The provider's stable identity for the object, unique within the connection. */
    readonly externalId: Schema.NonEmptyString;
    /** The provider object kind: `message`, `issue`, `issue-comment`, `event`. */
    readonly kind: Schema.NonEmptyString;
    /** A link to the object at the provider, when it has one. */
    readonly url: Schema.NullOr<Schema.String>;
    readonly author: Schema.NullOr<Schema.Struct<{
        /** The provider's stable user or bot id. */
        readonly id: Schema.NonEmptyString;
        /** A display label, when the provider supplied one. Never an identity. */
        readonly label: Schema.NullOr<Schema.String>;
    }>>;
    /** When the provider says the object was created, in Unix milliseconds. */
    readonly createdAtMs: Schema.NullOr<Schema.Number>;
    /** When the provider says the object last changed, in Unix milliseconds. */
    readonly updatedAtMs: Schema.NullOr<Schema.Number>;
    /** The provider's version token (an edit timestamp, an etag), when it has one. */
    readonly version: Schema.NullOr<Schema.String>;
    /** When this copy was retrieved, in Unix milliseconds. */
    readonly retrievedAtMs: Schema.Number;
    readonly access: Schema.Struct<{
        readonly scope: Schema.Literals<readonly ["private", "container", "workspace", "public"]>;
        /** The container the scope is relative to, or `null` when it names none. */
        readonly containerId: Schema.NullOr<Schema.NonEmptyString>;
    }>;
    readonly thread: Schema.Struct<{
        /** The channel, repository or calendar holding the record. */
        readonly containerId: Schema.NullOr<Schema.NonEmptyString>;
        /** The thread root's external id, or `null` outside a thread. */
        readonly threadId: Schema.NullOr<Schema.NonEmptyString>;
        /** The direct parent's external id (a comment's issue), or `null`. */
        readonly parentId: Schema.NullOr<Schema.NonEmptyString>;
    }>;
    /** Searchable text rendered by the provider adapter. Data, never instructions. */
    readonly text: Schema.String;
    /** Whether the provider deleted the object. A tombstone carries empty text and payload. */
    readonly deleted: Schema.Boolean;
    /** The provider payload, as delivered. */
    readonly payload: Schema.Codec<Schema.Json, Schema.Json, never, never>;
}>;
/**
 * One retrieved provider object with its provenance.
 *
 * @category models
 * @since 1.0.0
 */
export type SourceRecord = typeof SourceRecord.Type;
/**
 * Decodes an unknown value as a {@link SourceRecord}.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const decode: (input: unknown, options?: import("effect/SchemaAST").ParseOptions) => import("effect/Effect").Effect<{
    readonly provider: string;
    readonly connectionId: string;
    readonly externalId: string;
    readonly kind: string;
    readonly url: string | null;
    readonly author: {
        readonly id: string;
        readonly label: string | null;
    } | null;
    readonly createdAtMs: number | null;
    readonly updatedAtMs: number | null;
    readonly version: string | null;
    readonly retrievedAtMs: number;
    readonly access: {
        readonly scope: "container" | "private" | "public" | "workspace";
        readonly containerId: string | null;
    };
    readonly thread: {
        readonly containerId: string | null;
        readonly threadId: string | null;
        readonly parentId: string | null;
    };
    readonly text: string;
    readonly deleted: boolean;
    readonly payload: Schema.Json;
}, Schema.SchemaError, never>;
/**
 * The fields that order two copies of one record.
 *
 * @category models
 * @since 1.0.0
 */
export type Ordering = Pick<SourceRecord, "updatedAtMs" | "deleted" | "version">;
/**
 * Orders two provider version tokens.
 *
 * A missing token sorts first. Two decimal tokens compare as numbers, digit by
 * digit, so `10.5` follows `9.75` without a floating-point round trip that
 * would merge two microsecond-distinct timestamps. Decimal tokens sort before
 * opaque tokens; opaque tokens and numerically equal decimal spellings compare
 * by code unit. Ordering by token class first keeps mixed triples transitive.
 *
 * @category ordering
 * @since 1.0.0
 */
export declare const compareVersion: (left: string | null, right: string | null) => number;
/**
 * Orders two copies of one record: negative when `candidate` is older than
 * `current`, zero when neither is newer, positive when `candidate` is newer.
 *
 * The provider's change time decides first, and a copy with no change time is
 * older than any copy that has one. At the same time a deletion follows the
 * live copy, because a provider stamps a delete with the time of the version it
 * removed. Then the version token decides. Between two copies with no change
 * time, the version is the only change order, so it decides before deletion:
 * a provider without change times versions every copy, deletions and
 * restorations included, from one sequence. Each time class is ordered
 * lexicographically, so this is a total order and applying copies in any
 * order converges on the same winner.
 *
 * @category ordering
 * @since 1.0.0
 */
export declare const compare: (current: Ordering, candidate: Ordering) => number;
/**
 * Whether `candidate` is strictly newer than `current`.
 *
 * Ordered by `updatedAtMs`, then deletion, then `version`; see {@link compare}.
 * A copy equal on all three does not supersede, which is what makes applying
 * the same record twice a no-op.
 *
 * @category ordering
 * @since 1.0.0
 */
export declare const supersedes: (current: Ordering, candidate: Ordering) => boolean;
/**
 * What a tombstone keeps of the record it removes.
 *
 * @category models
 * @since 1.0.0
 */
export type Identity = Pick<SourceRecord, "provider" | "connectionId" | "externalId" | "kind" | "access" | "thread"> & Partial<Pick<SourceRecord, "createdAtMs" | "updatedAtMs" | "version">>;
/**
 * A tombstone: the provider deleted the object.
 *
 * It keeps identity, placement, times and version, and nothing else: text,
 * payload, author and link are empty, so a deleted object's content cannot be
 * retrieved from the tombstone. Its change time is the later of the removed
 * version's and `deletedAtMs`, so it supersedes the copy it removes and loses
 * to any later edit, which is how an object the provider restores comes back.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const tombstone: (of: Identity, deletedAtMs: number, retrievedAtMs?: number) => SourceRecord;
/**
 * The containers a record lives in: its access container and its thread
 * container, without duplicates. A record in none is readable only through a
 * grant that covers the whole connection.
 *
 * @category getters
 * @since 1.0.0
 */
export declare const containers: (record: Pick<SourceRecord, "access" | "thread">) => ReadonlyArray<string>;
/**
 * A pointer to one retrieved copy of a record, as a prompt or a run keeps it.
 *
 * A resumed run holds references, not text, and asks the store whether each
 * one is still readable and still the copy it used.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Reference: Schema.Struct<{
    readonly connectionId: Schema.NonEmptyString;
    readonly externalId: Schema.NonEmptyString;
    readonly updatedAtMs: Schema.NullOr<Schema.Number>;
    readonly version: Schema.NullOr<Schema.String>;
    readonly retrievedAtMs: Schema.Number;
}>;
/**
 * A pointer to one retrieved copy of a record.
 *
 * @category models
 * @since 1.0.0
 */
export type Reference = typeof Reference.Type;
/**
 * The reference to `record` as retrieved.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const reference: (record: SourceRecord) => Reference;
