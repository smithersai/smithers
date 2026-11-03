/**
 * The admission policy every cache tier applies at its input boundary: JSON
 * budgets, canonical encoding, argument validation, and entry snapshots.
 *
 * The SQL tier and the HTTP tier both admit a caller's input through these
 * operations, so a value one tier refuses the other refuses identically. The
 * policy depends on the entry model and the error alone, never on a tier.
 * `@smthrs/step-cache/CacheStore` re-exports it as part of the public contract.
 *
 * @since 0.1.0
 */
import * as BoundedJson from "@smthrs/canonical/BoundedJson";
import * as Effect from "effect/Effect";
import { CacheEntry, RecordedBy } from "./CacheEntry.vibe";
import { type CacheStoreError } from "./CacheStoreError.vibe";
/**
 * Maximum encoded bytes admitted for one `result` or `meta` JSON tree.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const maximumJsonBytes: number;
/**
 * Maximum nesting admitted for one cache JSON tree.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const maximumJsonDepth = 128;
/**
 * Maximum values admitted for one cache JSON tree.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const maximumJsonNodes = 100000;
/**
 * Maximum members admitted by one cache JSON array or object.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const maximumJsonMembers = 100000;
/**
 * Cache values always carry a finite byte budget and finite per-container
 * member, string, and key budgets, so every limit the shared boundary leaves
 * optional is required here. `maxTotalMembers` is omitted: the cache bounds
 * each container, and a whole tree by `maxNodes` and `maxBytes`.
 */
type CacheJsonLimits = Required<Omit<BoundedJson.Limits, "maxTotalMembers">>;
/**
 * The admission policy for one `result` or `meta` tree. The SQL tier decodes
 * stored JSON under it too, so a row it wrote always reads back.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export declare const jsonLimits: CacheJsonLimits;
/**
 * Encodes a stored value as RFC 8785 canonical JSON.
 *
 * `put` decides `ExistingSame` versus `Conflict` by comparing `result_json`
 * text. `JSON.stringify` output depends on key insertion order, so two
 * structurally equal results built in different orders compared unequal, and
 * `ActionPersistence` routes `Conflict` to the `Inconsistency` receiver whose
 * core default verdict is `fail` — the run failed with `CacheConflictDetected`
 * naming a divergence that did not exist. Canonicalizing on the way in makes
 * the text comparison a structural one, which is what `@smthrs/canonical`
 * exists for.
 *
 * `RemoteCacheStore.put` runs the same check before serializing an entry onto
 * the wire, so a value with no JSON form is refused identically by both tiers.
 *
 * @category serialization
 * @since 1.0.0-rc.0
 */
export declare const encodeCanonical: (value: unknown, field: string) => Effect.Effect<string, CacheStoreError>;
/**
 * Encodes a whole cache entry as RFC 8785 canonical JSON for the wire.
 *
 * The entry is admitted under the whole-entry policy documented on
 * `entryJsonLimits`: the two field budgets plus the envelope's one nesting
 * level and five nodes, with `maximumJsonBytes` bounding the encoding as a
 * whole. A remote lookup reads an entry back under exactly that policy, so a
 * publication that re-validates each field and then encodes here never
 * refuses an entry a `get` could have returned.
 *
 * @category serialization
 * @since 1.0.0-rc.0
 */
export declare const encodeEntryCanonical: (entry: CacheEntry) => Effect.Effect<string, CacheStoreError>;
/**
 * Validates a cache-key digest before any statement or request is issued.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export declare const validateKey: (keyDigest: string) => Effect.Effect<void, CacheStoreError>;
/**
 * Validates a provenance selector before a store performs I/O and returns the
 * schema-decoded copy (or `undefined`). Returning that detached value lets the
 * operation decode once and never reread caller-owned accessors.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export declare const validateRecordedBy: (recordedBy: RecordedBy | undefined, field?: string) => Effect.Effect<RecordedBy | undefined, CacheStoreError>;
/**
 * Refuses a malformed eviction fence before any statement or request is
 * issued. A fence naming an empty run or a sequence number no journal can
 * record is a compare-and-swap no row could ever satisfy; running it anyway
 * would misreport the caller's mistake as an ordinary "nothing matched".
 * It returns the decoded fence (or `undefined`) so the guarded delete uses
 * exactly the value that validation observed, including its inner fields.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export declare const validateFence: (fence: RecordedBy | undefined) => Effect.Effect<RecordedBy | undefined, CacheStoreError>;
/**
 * Refuses an age bound no row could satisfy before any statement is issued.
 * A negative or fractional millisecond count is a caller mistake, and running
 * it anyway would report that mistake as an ordinary miss.
 * It returns the checked primitive (or `undefined`) so an operation reads an
 * option accessor once and computes its age floor from that same value.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export declare const validateAge: (field: string, value: number | undefined) => Effect.Effect<number | undefined, CacheStoreError>;
/**
 * Takes an inert, detached snapshot of a cache entry at effect start.
 * Schema decoding builds a new top-level object, so the returned entry is
 * frozen after decoding; freezing only the provisional input would leave the
 * shell received by callers mutable.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export declare const snapshotEntry: (input: CacheEntry) => Effect.Effect<CacheEntry, CacheStoreError>;
export {};
