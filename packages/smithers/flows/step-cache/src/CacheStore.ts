/**
 * Durable content-addressed step result storage.
 *
 * This store receives already-computed digests and recorded results. It does
 * not interpret step layers, capabilities, or result metadata: `result` and
 * `meta` are admitted as bounded, inert JSON and stored verbatim.
 *
 * See the {@link https://smithers.sh/docs/concepts/content-addressing | step-key contract}
 * and {@link https://smithers.sh/docs/concepts/durable-execution | journal architecture}.
 *
 * @since 0.1.0
 */
import * as BoundedJson from "@smthrs/canonical/BoundedJson"
import { Canonical } from "@smthrs/canonical/Canonical"
import { affectedRows, DatabaseError, DurableWriter } from "@smthrs/database/DurableWriter"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import * as CacheStoreMetrics from "./CacheStoreMetrics.ts"

/**
 * Maximum encoded bytes admitted for one `result` or `meta` JSON tree.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumJsonBytes = 4 * 1024 * 1024

/**
 * Maximum nesting admitted for one cache JSON tree.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumJsonDepth = 128

/**
 * Maximum values admitted for one cache JSON tree.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumJsonNodes = 100_000

/**
 * Maximum members admitted by one cache JSON array or object.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumJsonMembers = 100_000

/**
 * Cache values always carry a finite byte budget and finite per-container
 * member, string, and key budgets, so every limit the shared boundary leaves
 * optional is required here. `maxTotalMembers` is omitted: the cache bounds
 * each container, and a whole tree by `maxNodes` and `maxBytes`.
 */
type CacheJsonLimits = Required<Omit<BoundedJson.Limits, "maxTotalMembers">>

const jsonLimits: CacheJsonLimits = {
  maxBytes: maximumJsonBytes,
  maxDepth: maximumJsonDepth,
  maxMembers: maximumJsonMembers,
  maxNodes: maximumJsonNodes,
  maxStringBytes: maximumJsonBytes,
  maxKeyBytes: 16 * 1024
}

/**
 * The admission policy for a whole wire entry: each field's own budget, plus
 * the envelope itself. The envelope adds one nesting level above `result` and
 * `meta`, and five nodes (the entry object and its four scalar members), while
 * `maximumJsonBytes` still bounds the whole encoding. Remote reads admit an
 * entry field-by-field under `jsonLimits` with the same whole-entry byte
 * bound, so encoding under these allowances keeps publication symmetric with
 * lookup: an entry a `get` returned always fits a `put`.
 */
const entryJsonLimits: CacheJsonLimits = {
  ...jsonLimits,
  maxDepth: maximumJsonDepth + 1,
  maxNodes: 2 * maximumJsonNodes + 5
}

/**
 * Stable error codes returned by cache persistence operations.
 *
 * @category models
 * @since 0.1.0
 */
export const CacheStoreErrorCode = Schema.Literals([
  "invalid_cache",
  "constraint",
  "decode_failed",
  "persistence_failed",
  "unknown"
])

/**
 * Stable error codes returned by cache persistence operations.
 *
 * @category models
 * @since 0.1.0
 */
export type CacheStoreErrorCode = typeof CacheStoreErrorCode.Type

/**
 * Error raised by cache persistence operations.
 *
 * The identity string equals the defining module path, like every other
 * identity in this repository.
 *
 * @category errors
 * @since 0.1.0
 */
export class CacheStoreError extends Schema.TaggedError<CacheStoreError>()(
  "@smthrs/step-cache/CacheStoreError",
  {
    code: CacheStoreErrorCode,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

const NonNegativeSafeInt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

/**
 * Maximum number of characters accepted in one cache-key digest.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumKeyDigestLength = 256

/**
 * One URL-segment-safe cache-key digest.
 *
 * The cache key is accepted at both SQL and HTTP boundaries. Restricting it
 * to this grammar makes `.` / `..`, separators, controls, and ill-formed
 * Unicode unrepresentable before either boundary is touched.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const KeyDigest = Schema.String.check(
  Schema.isMaxLength(maximumKeyDigestLength),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/, {
    expected: "1-256 URL-safe letters, digits, underscores, or hyphens"
  })
)

/**
 * A validated cache-key digest.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type KeyDigest = typeof KeyDigest.Type

/**
 * Maximum number of UTF-16 code units accepted in a recording run id.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumRecordedRunIdLength = 1_024

const isWellFormedText = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(++index)
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return !value.includes("\0")
}

const wellFormedText = Schema.makeFilter(
  isWellFormedText,
  { title: "wellFormedText" }
)

/**
 * Run id carried by an immutable cache provenance record.
 *
 * Non-empty, well-formed text without a NUL, of at most
 * {@link maximumRecordedRunIdLength} code units. Other control characters are
 * admitted deliberately: the id is opaque here, it reaches SQL as a bound
 * parameter and the wire as a percent-encoded query value, and every stored
 * ledger row is read back through this schema, so narrowing it would make a row
 * an earlier build persisted undecodable.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const RecordedRunId = Schema.NonEmptyString.check(
  Schema.isMaxLength(maximumRecordedRunIdLength),
  wellFormedText
)

/**
 * Exact journal event that recorded a cache result.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const RecordedBy = Schema.Struct({
  runId: RecordedRunId,
  eventSeq: NonNegativeSafeInt
})

/**
 * Exact journal event that recorded a cache result.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type RecordedBy = typeof RecordedBy.Type

/**
 * The durable data recorded for a cache key.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CacheEntry = Schema.Struct({
  keyDigest: KeyDigest,
  result: Schema.Unknown,
  meta: Schema.Unknown,
  createdAtMs: NonNegativeSafeInt,
  recordedRunId: RecordedRunId,
  recordedEventSeq: NonNegativeSafeInt
})

/**
 * The durable data recorded for a cache key.
 *
 * @category models
 * @since 0.1.0
 */
export type CacheEntry = typeof CacheEntry.Type

/**
 * Provenance selector for a lookup.
 *
 * @category models
 * @since 0.1.0
 */
export type GetOptions = {
  /**
   * Prefers the entry as it was recorded by this `(runId, eventSeq)` pair —
   * the append-only `flows_step_cache_recorded` ledger row a `put` lands
   * beside the head — falling back to the mutable head when no recorded
   * version under that provenance exists. Replay reads through this fence so
   * an old frame's projection stays a function of durable state: evicting or
   * replacing the head never changes what that event recorded.
   */
  readonly recordedBy?: RecordedBy
  /**
   * Refuses an entry recorded more than `maxAgeMs` before the current clock
   * reading, so a caller that declared a time-to-live reads a miss instead of
   * a stale result. The bound applies to the recorded ledger and to the head
   * alike: both carry the `createdAtMs` the age is measured from.
   *
   * The bound is a read policy, never a deletion. An expired row stays on
   * disk until {@link Service.sweepExpired} removes it, so a second caller
   * declaring a longer bound still reads it.
   */
  readonly maxAgeMs?: number
}

/**
 * Fencing predicate for an eviction.
 *
 * @category models
 * @since 0.1.0
 */
export type EvictOptions = {
  /**
   * Deletes the row only while it is still the one recorded by this
   * `(runId, eventSeq)` pair. Omitting the predicate deletes unconditionally.
   */
  readonly ifRecordedBy?: RecordedBy
}

/**
 * Optional collection policy for ledger evidence, including remote imports.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface SweepOptions {
  /**
   * Authorizes deleting one old provenance only after every local journal,
   * fork, and run reference has been released. Omitting the policy preserves
   * all rows.
   * A foreign run id alone does not prove the absence of local references.
   *
   * Runs as a local read inside the sweep's writer transaction. Failure rolls
   * back the entire sweep. The host must quiesce execution and replay across
   * all database users before checking references and until the sweep commits:
   * a write lock alone cannot protect a lookup not yet journalled. Do not
   * perform network I/O or mutate the store from this callback.
   */
  readonly canReclaimRecorded?: (
    reference: Pick<CacheEntry, "keyDigest" | "recordedRunId" | "recordedEventSeq">
  ) => Effect.Effect<boolean, CacheStoreError>
}

/**
 * Result of recording an entry under a content digest.
 *
 * @category models
 * @since 0.1.0
 */
export type PutResult =
  | { readonly _tag: "Inserted" }
  | { readonly _tag: "ExistingSame" }
  | { readonly _tag: "Conflict" }

/**
 * Content-addressed cache persistence operations.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  /**
   * The entry under `keyDigest`: the mutable head by default, or — with
   * `recordedBy` — the durable recorded version that exact event landed,
   * falling back to the head only when the ledger holds no row for that
   * provenance. A recorded row the {@link GetOptions.maxAgeMs} bound refuses
   * is a miss, never a fall-through to the head.
   */
  readonly get: (
    keyDigest: string,
    options?: GetOptions
  ) => Effect.Effect<Option.Option<CacheEntry>, CacheStoreError>
  readonly put: (entry: CacheEntry) => Effect.Effect<PutResult, CacheStoreError>
  /**
   * Removes the row for `keyDigest`, returning whether a row was deleted.
   * With `ifRecordedBy` the delete is a single fenced compare-and-swap, so a
   * fresher row landed by a foreign process is never deleted with the poison
   * (issue #119).
   */
  readonly evict: (
    keyDigest: string,
    options?: EvictOptions
  ) => Effect.Effect<boolean, CacheStoreError>
  /**
   * Removes every head row recorded more than `olderThanMs` before the
   * current clock reading, returning how many were deleted.
   *
   * The sweep is the collection half of {@link GetOptions.maxAgeMs}: the
   * bound decides what a read serves, this decides what the database keeps.
   * The immutable `flows_step_cache_recorded` ledger is preserved unless
   * {@link SweepOptions.canReclaimRecorded} explicitly authorizes collecting
   * an old row. Both checks and deletion share the writer transaction. The
   * return value counts heads only, even when ledger rows are reclaimed.
   *
   * Whole-run reclamation remains `@smthrs/engine-store`'s Retention, which
   * deletes ledger rows with the run's journal. Foreign imports cannot match
   * that run-scoped delete; a host composing a shared tier must schedule a
   * reference-aware sweep to bound unreferenced imported evidence.
   */
  readonly sweepExpired: (olderThanMs: number, options?: SweepOptions) => Effect.Effect<number, CacheStoreError>
}

/**
 * Service tag for content-addressed recorded step results.
 *
 * The identity string equals the defining module path, like every other
 * service identity in this repository. The pre-split `flows/journal/CacheStore`
 * identity was retired before rc.0, while no persisted journal or step-key
 * digest named it. See the
 * {@link https://smithers.sh/docs/concepts/durable-execution | journal architecture}.
 *
 * @category services
 * @since 0.1.0
 */
export class CacheStore extends Context.Service<CacheStore, Service>()("@smthrs/step-cache/CacheStore") {}

const CacheRow = Schema.Struct({
  key_digest: KeyDigest,
  result_json: Schema.String,
  meta_json: Schema.String,
  created_at_ms: NonNegativeSafeInt,
  recorded_run_id: RecordedRunId,
  recorded_event_seq: NonNegativeSafeInt
})

type CacheRow = typeof CacheRow.Type

const error = (code: CacheStoreErrorCode, message: string, cause?: unknown): CacheStoreError =>
  new CacheStoreError({ code, message, ...(cause === undefined ? {} : { cause }) })

const encodeBounded = (
  value: unknown,
  field: string,
  limits: CacheJsonLimits
): Effect.Effect<string, CacheStoreError> =>
  Effect.suspend(() => {
    const admitted = BoundedJson.admit(value, limits)
    return admitted.ok
      ? Schema.decodeUnknownEffect(Canonical)(admitted.value).pipe(
        /* v8 ignore next -- bounded inert JSON is exactly Canonical's accepted domain */
        Effect.mapError(() => error("invalid_cache", `${field} must have a bounded canonical JSON form`))
      )
      : Effect.fail(error("invalid_cache", `${field} ${admitted.complaint}`))
  })

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
export const encodeCanonical = (value: unknown, field: string): Effect.Effect<string, CacheStoreError> =>
  encodeBounded(value, field, jsonLimits)

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
export const encodeEntryCanonical = (entry: CacheEntry): Effect.Effect<string, CacheStoreError> =>
  encodeBounded(entry, "cache entry", entryJsonLimits)

const decode = (value: string, field: string): Effect.Effect<unknown, CacheStoreError> =>
  Effect.suspend(() => {
    if (value.length > maximumJsonBytes) {
      return Effect.fail(error("decode_failed", `${field} exceeds the ${maximumJsonBytes}-byte limit`))
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(value) as unknown
    } catch {
      return Effect.fail(error("decode_failed", `could not decode ${field}`))
    }
    const admitted = BoundedJson.admit(parsed, jsonLimits)
    return admitted.ok
      ? Effect.succeed(admitted.value)
      : Effect.fail(error("decode_failed", `${field} ${admitted.complaint}`))
  })

/**
 * Validates a cache-key digest before any statement or request is issued.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export const validateKey = (keyDigest: string): Effect.Effect<void, CacheStoreError> =>
  Schema.decodeUnknownEffect(KeyDigest)(keyDigest).pipe(
    Effect.asVoid,
    Effect.mapError((cause) => error("invalid_cache", "keyDigest violates the cache-key contract", cause))
  )

/**
 * Validates a provenance selector before a store performs I/O and returns the
 * schema-decoded copy (or `undefined`). Returning that detached value lets the
 * operation decode once and never reread caller-owned accessors.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export const validateRecordedBy = (
  recordedBy: RecordedBy | undefined,
  field = "recordedBy"
): Effect.Effect<RecordedBy | undefined, CacheStoreError> =>
  recordedBy === undefined
    ? Effect.succeed(undefined)
    : Schema.decodeUnknownEffect(RecordedBy)(recordedBy).pipe(
      Effect.mapError((cause) => error("invalid_cache", `${field} violates the provenance contract`, cause))
    )

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
export const validateFence = (
  fence: EvictOptions["ifRecordedBy"]
): Effect.Effect<RecordedBy | undefined, CacheStoreError> => validateRecordedBy(fence, "eviction fence")

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
export const validateAge = (
  field: string,
  value: number | undefined
): Effect.Effect<number | undefined, CacheStoreError> =>
  value === undefined || (Number.isSafeInteger(value) && value >= 0)
    ? Effect.succeed(value)
    : Effect.fail(error("invalid_cache", `${field} must be a non-negative safe integer`))

/**
 * Takes an inert, detached snapshot of a cache entry at effect start.
 * Schema decoding builds a new top-level object, so the returned entry is
 * frozen after decoding; freezing only the provisional input would leave the
 * shell received by callers mutable.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export const snapshotEntry = (input: CacheEntry): Effect.Effect<CacheEntry, CacheStoreError> =>
  Effect.suspend(() => {
    try {
      if (typeof input !== "object" || input === null) throw new TypeError("entry")
      const names = ["keyDigest", "result", "meta", "createdAtMs", "recordedRunId", "recordedEventSeq"] as const
      const values = Object.create(null) as Record<(typeof names)[number], unknown>
      for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(input, name)
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          throw new TypeError("entry")
        }
        values[name] = descriptor.value
      }
      for (const key of Reflect.ownKeys(input)) {
        if (typeof key !== "string" || !(names as ReadonlyArray<string>).includes(key)) {
          if (Object.getOwnPropertyDescriptor(input, key)?.enumerable) throw new TypeError("entry")
        }
      }
      const result = BoundedJson.admit(values.result, jsonLimits)
      const meta = BoundedJson.admit(values.meta, jsonLimits)
      if (!result.ok || !meta.ok) {
        return Effect.fail(error(
          "invalid_cache",
          !result.ok ? `result ${result.complaint}` : `meta ${(meta as { readonly complaint: string }).complaint}`
        ))
      }
      const snapshot = Object.freeze({
        keyDigest: values.keyDigest,
        result: result.value,
        meta: meta.value,
        createdAtMs: values.createdAtMs,
        recordedRunId: values.recordedRunId,
        recordedEventSeq: values.recordedEventSeq
      })
      return Schema.decodeUnknownEffect(CacheEntry)(snapshot).pipe(
        Effect.map((entry) => Object.freeze(entry)),
        Effect.mapError(() => error("invalid_cache", "cache entry violates the persistence contract"))
      )
    } catch {
      return Effect.fail(error("invalid_cache", "cache entry cannot be inspected as inert data"))
    }
  })

const mapPersistenceError = (cause: unknown): CacheStoreError => {
  if (Schema.is(CacheStoreError)(cause)) {
    return cause
  }
  const constraint = Schema.is(DatabaseError)(cause)
    ? cause.code === "constraint"
    : SqlError.isSqlError(cause) &&
      (cause.reason instanceof SqlError.ConstraintError || cause.reason instanceof SqlError.UniqueViolation)
  return error(
    constraint ? "constraint" : "persistence_failed",
    "cache persistence failed",
    cause
  )
}

const decodeRow = (input: unknown): Effect.Effect<CacheEntry, CacheStoreError> =>
  Schema.decodeUnknownEffect(CacheRow)(input).pipe(
    Effect.mapError((cause) => error("decode_failed", "could not decode flows_step_cache row", cause)),
    Effect.flatMap((row) =>
      Effect.all({ result: decode(row.result_json, "result_json"), meta: decode(row.meta_json, "meta_json") }).pipe(
        Effect.map(({ result, meta }) => ({
          keyDigest: row.key_digest,
          result,
          meta,
          createdAtMs: row.created_at_ms,
          recordedRunId: row.recorded_run_id,
          recordedEventSeq: row.recorded_event_seq
        }))
      )
    )
  )

/**
 * Builds the SQL-backed cache store.
 *
 * A cache hit is returned as the step's result, so cached values are
 * executable state and are persisted verbatim; rewriting them here would
 * serve a different value than the one the step produced (issue #72).
 *
 * @category constructors
 * @since 0.1.0
 */
export const make: Effect.Effect<Service, never, DurableWriter | SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const writer = yield* DurableWriter

  const get: Service["get"] = Effect.fn("CacheStore.get")((keyDigest, options) =>
    Effect.gen(function*() {
      yield* Effect.annotateCurrentSpan({ keyDigest })
      yield* validateKey(keyDigest)
      const maxAgeMs = yield* validateAge("maxAgeMs", options?.maxAgeMs)
      const recordedBy = yield* validateRecordedBy(options?.recordedBy)
      // The age floor is resolved once, from the injected clock, so both reads
      // below judge the same instant and a row cannot be fresh for the ledger
      // read and stale for the head read of one lookup. The validated value,
      // not the caller's option object, is the only value this computation reads.
      const floorMs = maxAgeMs === undefined
        ? undefined
        : (yield* Clock.currentTimeMillis) - maxAgeMs
      const withinBound = (row: CacheEntry): boolean => floorMs === undefined || row.createdAtMs >= floorMs
      if (recordedBy !== undefined) {
        // The ledger row is the durable evidence a replay of that exact event
        // must read; the head is only the fallback for entries recorded under
        // another provenance (a fork sharing the parent's keys, a shared-tier
        // write-back, a pre-ledger row).
        const recorded = yield* sql<Record<string, unknown>>`
          SELECT key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
          FROM flows_step_cache_recorded
          WHERE key_digest = ${keyDigest}
            AND recorded_run_id = ${recordedBy.runId}
            AND recorded_event_seq = ${recordedBy.eventSeq}
        `.pipe(Effect.mapError(mapPersistenceError))
        if (recorded.length > 0) {
          const entry = yield* decodeRow(recorded[0]!)
          if (withinBound(entry)) {
            yield* Metric.update(CacheStoreMetrics.hit, 1)
            return Option.some(entry)
          }
          // The exact row exists and is older than the bound, so the answer is
          // a miss. Falling through to the head here would hand a replay of
          // that event whatever a later run recorded under the same key, which
          // is a different result than the one the caller asked to read.
          yield* Metric.update(CacheStoreMetrics.miss, 1)
          return Option.none()
        }
      }
      const rows = yield* sql<Record<string, unknown>>`
        SELECT key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
        FROM flows_step_cache WHERE key_digest = ${keyDigest}
      `.pipe(Effect.mapError(mapPersistenceError))
      if (rows.length === 0) {
        yield* Metric.update(CacheStoreMetrics.miss, 1)
        return Option.none()
      }
      const entry = yield* decodeRow(rows[0]!)
      if (!withinBound(entry)) {
        yield* Metric.update(CacheStoreMetrics.miss, 1)
        return Option.none()
      }
      yield* Metric.update(CacheStoreMetrics.hit, 1)
      return Option.some(entry)
    })
  )

  const put: Service["put"] = Effect.fn("CacheStore.put")((candidate) =>
    Effect.gen(function*() {
      const entry = yield* snapshotEntry(candidate)
      yield* Effect.annotateCurrentSpan({ keyDigest: entry.keyDigest })
      const result = yield* encodeCanonical(entry.result, "result")
      const meta = yield* encodeCanonical(entry.meta, "meta")
      return yield* writer.write(
        Effect.gen(function*() {
          // The provenance row is immutable. If another write already used
          // this exact journal identity, its complete bytes decide whether
          // this attempt is a retry or a conflict before a mutable head can
          // be created or restored.
          const recorded = yield* sql`
            INSERT INTO flows_step_cache_recorded (
              key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
            ) VALUES (
              ${entry.keyDigest}, ${result}, ${meta}, ${entry.createdAtMs}, ${entry.recordedRunId}, ${entry.recordedEventSeq}
            ) ON CONFLICT (key_digest, recorded_run_id, recorded_event_seq) DO NOTHING
          `.raw.pipe(Effect.mapError(mapPersistenceError))
          if ((yield* affectedRows(recorded)) === 0) {
            const ledger = yield* sql<CacheRow>`
              SELECT key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
              FROM flows_step_cache_recorded
              WHERE key_digest = ${entry.keyDigest}
                AND recorded_run_id = ${entry.recordedRunId}
                AND recorded_event_seq = ${entry.recordedEventSeq}
            `.pipe(Effect.mapError(mapPersistenceError))
            /* v8 ignore next -- the row blocked this insert in the same serialized transaction */
            if (ledger.length === 0) {
              return yield* Effect.fail(error("unknown", "cache provenance disappeared during put"))
            }
            const existing = ledger[0]!
            if (
              existing.result_json !== result ||
              existing.meta_json !== meta ||
              existing.created_at_ms !== entry.createdAtMs
            ) {
              return { _tag: "Conflict" } as const
            }
          }
          const inserted = yield* sql`
            INSERT INTO flows_step_cache (
              key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
            ) VALUES (
              ${entry.keyDigest}, ${result}, ${meta}, ${entry.createdAtMs}, ${entry.recordedRunId}, ${entry.recordedEventSeq}
            ) ON CONFLICT (key_digest) DO NOTHING
          `.raw.pipe(Effect.mapError(mapPersistenceError))
          if ((yield* affectedRows(inserted)) > 0) {
            return { _tag: "Inserted" } as const
          }
          const rows = yield* sql<Pick<CacheRow, "result_json">>`
            SELECT result_json FROM flows_step_cache WHERE key_digest = ${entry.keyDigest}
          `.pipe(Effect.mapError(mapPersistenceError))
          /* v8 ignore next -- the conflicting row is read in the same serialized write transaction */
          if (rows.length === 0) {
            return yield* Effect.fail(error("unknown", "cache entry disappeared during put"))
          }
          return rows[0]!.result_json === result
            ? { _tag: "ExistingSame" } as const
            : { _tag: "Conflict" } as const
        })
      ).pipe(
        Effect.mapError(mapPersistenceError),
        Effect.tap((outcome) => Metric.update(CacheStoreMetrics.put[outcome._tag], 1))
      )
    })
  )

  const evict: Service["evict"] = Effect.fn("CacheStore.evict")((keyDigest, options) =>
    Effect.gen(function*() {
      yield* Effect.annotateCurrentSpan({ keyDigest })
      yield* validateKey(keyDigest)
      const fenced = yield* validateFence(options?.ifRecordedBy)
      // The provenance predicate rides in the DELETE itself (issue #119):
      // a read-then-delete leaves a window in which another *process* records
      // a fresh row under the same key, and the unconditional delete would
      // drop it. Temporal fences its mutable-state writes the same way — the
      // guard is part of the write, never a prior read. The statement reads the
      // decoded fence, never the caller's provenance object.
      const deleted = yield* writer.write(
        fenced === undefined
          ? sql`DELETE FROM flows_step_cache WHERE key_digest = ${keyDigest}`.raw
          : sql`
            DELETE FROM flows_step_cache
            WHERE key_digest = ${keyDigest}
              AND recorded_run_id = ${fenced.runId}
              AND recorded_event_seq = ${fenced.eventSeq}
          `.raw
      ).pipe(
        Effect.flatMap(affectedRows),
        Effect.mapError(mapPersistenceError)
      )
      return deleted > 0
    })
  )

  const sweepExpired: Service["sweepExpired"] = Effect.fn("CacheStore.sweepExpired")((olderThanMs, options) =>
    Effect.gen(function*() {
      yield* validateAge("olderThanMs", olderThanMs)
      const floorMs = (yield* Clock.currentTimeMillis) - olderThanMs
      yield* Effect.annotateCurrentSpan({ floorMs })
      const canReclaimRecorded = options?.canReclaimRecorded
      const deleted = yield* writer.write(Effect.gen(function*() {
        const heads = yield* sql`DELETE FROM flows_step_cache WHERE created_at_ms < ${floorMs}`.raw.pipe(
          Effect.flatMap(affectedRows)
        )
        if (canReclaimRecorded !== undefined) {
          // Keyset pagination bounds memory without starving later imports
          // behind a page of retained evidence. The empty key sorts before
          // every admitted digest. Keep the cursor even when its row is deleted.
          type ReferenceRow = Pick<CacheRow, "key_digest" | "recorded_run_id" | "recorded_event_seq">
          let cursor: ReferenceRow = { key_digest: "", recorded_run_id: "", recorded_event_seq: 0 }
          while (true) {
            const rows = yield* sql<ReferenceRow>`
              SELECT key_digest, recorded_run_id, recorded_event_seq
              FROM flows_step_cache_recorded
              WHERE created_at_ms < ${floorMs}
                AND (key_digest, recorded_run_id, recorded_event_seq) >
                  (${cursor.key_digest}, ${cursor.recorded_run_id}, ${cursor.recorded_event_seq})
              ORDER BY key_digest, recorded_run_id, recorded_event_seq
              LIMIT 100
            `
            if (rows.length === 0) break
            for (const row of rows) {
              const reclaim = yield* canReclaimRecorded({
                keyDigest: row.key_digest,
                recordedRunId: row.recorded_run_id,
                recordedEventSeq: row.recorded_event_seq
              })
              if (reclaim) {
                yield* sql`
                  DELETE FROM flows_step_cache_recorded
                  WHERE key_digest = ${row.key_digest}
                    AND recorded_run_id = ${row.recorded_run_id}
                    AND recorded_event_seq = ${row.recorded_event_seq}
                    AND created_at_ms < ${floorMs}
                `
              }
            }
            cursor = rows[rows.length - 1]!
          }
        }
        return heads
      })).pipe(Effect.mapError(mapPersistenceError))
      return deleted
    })
  )

  return { get, put, evict, sweepExpired }
})

/**
 * Creates a cache store whose every operation fails as unavailable, with
 * optional per-method overrides. This is the test and {@link layerNoop} seam:
 * a caller that reaches an operation the test did not supply is told which one
 * it was, instead of reading a silent miss.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service => {
  const unavailable = (method: string) => Effect.fail(error("unknown", `${method} is unavailable`))
  return CacheStore.of({
    get: Effect.fn("CacheStore.get")(() => unavailable("get")),
    put: Effect.fn("CacheStore.put")(() => unavailable("put")),
    evict: Effect.fn("CacheStore.evict")(() => unavailable("evict")),
    sweepExpired: Effect.fn("CacheStore.sweepExpired")(() => unavailable("sweepExpired")),
    ...overrides
  })
}

/**
 * Provides a no-op cache store.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<CacheStore> =>
  Layer.succeed(CacheStore)(makeNoop(overrides))

/**
 * Provides the SQL-backed cache store.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<CacheStore, never, DurableWriter | SqlClient.SqlClient> = Layer.effect(CacheStore)(make)
