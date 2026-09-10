/**
 * Cloudflare Worker entry point for the hosted build cache.
 *
 * @since 0.1.0
 */
import { CacheFailure } from "./cache-failure.ts"
import {
  type ActionCache,
  type ActionCachePublication,
  canonicalJson,
  type ContentStore,
  createHandler,
  type CredentialBudget,
  describeFailure,
  maxArtifactBodyBytes,
  maxCanonicalJsonBytes
} from "./protocol.ts"

interface CacheWorkerEnv {
  readonly CACHE_DATABASE: D1Database
  readonly CACHE_BUCKET: R2Bucket
  /** Counts every admitted request per credential digest at this location. */
  readonly CACHE_REQUEST_BUDGET: RateLimit
  /** Counts `findMissing` probes per credential digest at this location. */
  readonly CACHE_FIND_MISSING_BUDGET: RateLimit
  /** SHA-256 of the pull credential every job may hold, trusted or not. */
  readonly CACHE_READ_TOKEN: string
  /** SHA-256 of the publish credential only post-merge jobs may hold. */
  readonly CACHE_WRITE_TOKEN: string
}

interface KeyRow {
  readonly key_digest: string
}

interface EntryRow {
  readonly entry_json: string
  /** `1` when the row's last access is older than {@link readTouchDays}. */
  readonly stale: number
}

interface ResultRow {
  readonly result_json: string
}

interface HealthRow {
  readonly ok: number
}

const healthObjectKey = "__smithers_build_healthcheck__"
const findMissingConcurrency = 16
const maxPublicationAttempts = 3

/**
 * How long an unread action-cache entry survives.
 *
 * D1 holds 10 GB per database and an entry is up to 1 MiB, so an unpruned
 * store reaches its ceiling at roughly ten thousand entries and every
 * publication after that fails. Deleting a cold entry only costs the next
 * build a cache miss, so retention is a plain time window over the
 * `last_accessed_at` index the read path maintains once per {@link readTouchDays}.
 *
 * @category constants
 * @since 0.1.0
 */
export const retentionDays = 30

/**
 * How long a read leaves an entry's access metadata alone.
 *
 * `GET /ac/{key}` is the read credential's route, and the read credential is
 * public within the organization, so a read must not be a write: one that
 * updated its row on every hit would let any reader drive metered D1 writes
 * and keep an entry alive past retention one request at a time. A read
 * touches `last_accessed_at` only when the row's last access is older than
 * this, so a hot key costs one write a day and an entry read daily still
 * stays inside {@link retentionDays}.
 *
 * @category constants
 * @since 0.1.0
 */
export const readTouchDays = 1

const staleReadCutoff = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${readTouchDays} days')`

const retentionBatchRows = 500
const maxRetentionBatches = 20
const millisecondsPerDay = 24 * 60 * 60 * 1000

const digestBytes = (digest: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(
    { length: digest.length / 2 },
    (_, index) => Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16)
  )

const sameBytes = (left: ArrayBuffer, right: Uint8Array<ArrayBuffer>): boolean => {
  const candidate = new DataView(left)
  if (candidate.byteLength !== right.byteLength) return false
  let difference = 0
  // The lengths agree, so every index of `right` reads inside `candidate`.
  right.forEach((byte, index) => {
    difference |= byte ^ candidate.getUint8(index)
  })
  return difference === 0
}

/**
 * Refuses an object the provider should never have returned.
 *
 * A wrong key or an impossible size is a broken bucket, not a repairable
 * object: no client republication would change the answer, so it stays a
 * storage refusal.
 */
const assertObjectShape = (digest: string, object: R2Object): void => {
  if (
    object.key !== digest ||
    !Number.isSafeInteger(object.size) ||
    object.size < 0 ||
    object.size > maxArtifactBodyBytes
  ) {
    throw new CacheFailure(
      "R2_OBJECT_INVALID",
      "r2.validate",
      "R2 returned an object outside the content-store invariant"
    )
  }
}

/**
 * Reports why a well-shaped object's checksum does not prove its address.
 *
 * Returns `null` when the checksum verifies. Every other answer names the
 * single failed check and is safe to log: it carries the content address and
 * never the object's bytes. This is the repairable half of the invariant, the
 * one a client republication fixes.
 */
const contentChecksumFault = (digest: string, object: R2Object): string | null => {
  const checksum = object.checksums.sha256
  if (checksum === undefined) return "R2 returned an object without a SHA-256 checksum"
  if (!sameBytes(checksum, digestBytes(digest))) {
    return "R2 returned an object with a mismatched SHA-256 checksum"
  }
  return null
}

const assertContentObject = (digest: string, object: R2Object): void => {
  assertObjectShape(digest, object)
  const fault = contentChecksumFault(digest, object)
  if (fault !== null) throw new CacheFailure("R2_CHECKSUM_INVALID", "r2.validate", fault)
}

/**
 * Reports an unverifiable object as absent so the client republishes it.
 *
 * A stored object whose provider checksum is missing or wrong is not CAS
 * content, and only `put` can repair it. Refusing the read instead would
 * answer `503`, which the client retries rather than treating as a miss, so
 * the digest would stay wedged for as long as the object survives.
 */
const reportAbsent = (digest: string, fault: string): void => {
  console.error(`smithers build cache: ${fault}; reporting ${digest} absent so a publisher repairs it`)
}

const discardObjectBody = (object: R2ObjectBody): void => {
  try {
    void object.body.cancel().catch(() => undefined)
  } catch {
    // A body that cannot be cancelled is already unusable; the answer stands.
  }
}

const validateStoredResult = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength > maxCanonicalJsonBytes
  ) throw new CacheFailure("D1_RESULT_INVALID", "actionCache.put", "D1 returned an invalid action-cache discriminator")
  let canonical: string
  try {
    canonical = canonicalJson(JSON.parse(value) as unknown)
  } catch {
    throw new CacheFailure("D1_RESULT_INVALID", "actionCache.put", "D1 returned an invalid action-cache discriminator")
  }
  if (canonical !== value) {
    throw new CacheFailure(
      "D1_RESULT_NON_CANONICAL",
      "actionCache.put",
      "D1 returned a non-canonical action-cache discriminator"
    )
  }
  return value
}

const insertEntry = (
  database: D1Database,
  keyDigest: string,
  publication: ActionCachePublication
): Promise<KeyRow | null> =>
  database
    .prepare(
      `INSERT INTO smithers_build_cache_entry (
        key_digest,
        entry_json,
        result_json,
        created_at_ms,
        recorded_run_id,
        recorded_event_seq
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (key_digest) DO NOTHING
      RETURNING key_digest`
    )
    .bind(
      keyDigest,
      publication.body,
      publication.resultJson,
      publication.createdAtMs,
      publication.recordedRunId,
      publication.recordedEventSeq
    )
    .first<KeyRow>()

const readAndTouchStoredResult = (
  database: D1Database,
  keyDigest: string
): Promise<ResultRow | null> =>
  database
    .prepare(
      `UPDATE smithers_build_cache_entry
      SET last_accessed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          access_count = CASE
            WHEN access_count < 9223372036854775807 THEN access_count + 1
            ELSE access_count
          END
      WHERE key_digest = ?
      RETURNING result_json`
    )
    .bind(keyDigest)
    .first<ResultRow>()

/**
 * Refreshes the access metadata of a row a read found stale.
 *
 * The cutoff is repeated in the predicate, so two readers that both found the
 * row stale write it once, and a row deleted between the read and the touch
 * stays deleted.
 */
const touchStaleEntry = (database: D1Database, keyDigest: string): Promise<KeyRow | null> =>
  database
    .prepare(
      `UPDATE smithers_build_cache_entry
      SET last_accessed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          access_count = CASE
            WHEN access_count < 9223372036854775807 THEN access_count + 1
            ELSE access_count
          END
      WHERE key_digest = ? AND last_accessed_at < ${staleReadCutoff}
      RETURNING key_digest`
    )
    .bind(keyDigest)
    .first<KeyRow>()

/**
 * Adapts D1 to result-only, first-writer-wins head arbitration.
 *
 * The HTTP protocol refuses new journal identities. Existing provenance
 * columns remain available for fenced deletion of legacy rows; this adapter
 * does not retain an immutable journal-identity ledger.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeActionCache = (database: D1Database): ActionCache => ({
  async get(keyDigest) {
    // A read is a row read; it becomes a row write only once a day per key.
    const row = await database
      .prepare(
        `SELECT entry_json, last_accessed_at < ${staleReadCutoff} AS stale
        FROM smithers_build_cache_entry
        WHERE key_digest = ?`
      )
      .bind(keyDigest)
      .first<EntryRow>()
    if (row === null) return null
    if (row.stale === 1) await touchStaleEntry(database, keyDigest)
    return row.entry_json
  },
  async put(keyDigest, publication) {
    for (let attempt = 0; attempt < maxPublicationAttempts; attempt += 1) {
      if ((await insertEntry(database, keyDigest, publication)) !== null) return "inserted"
      const stored = await readAndTouchStoredResult(database, keyDigest)
      if (stored !== null) {
        return validateStoredResult(stored.result_json) === publication.resultJson ? "identical" : "conflict"
      }
    }
    throw new CacheFailure("D1_PUBLICATION_LOST", "actionCache.put", "action-cache publication lost its row repeatedly")
  },
  async delete(keyDigest, fence) {
    const row = fence === null
      ? await database
        .prepare("DELETE FROM smithers_build_cache_entry WHERE key_digest = ? RETURNING key_digest")
        .bind(keyDigest)
        .first<KeyRow>()
      : await database
        .prepare(
          `DELETE FROM smithers_build_cache_entry
              WHERE key_digest = ?
                AND recorded_run_id = ?
                AND recorded_event_seq = ?
              RETURNING key_digest`
        )
        .bind(keyDigest, fence.runId, fence.eventSeq)
        .first<KeyRow>()
    return row !== null
  }
})

/**
 * Adapts R2 to the checksum-verifying content-store contract.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeContentStore = (bucket: R2Bucket): ContentStore => ({
  async get(digest) {
    const object = await bucket.get(digest)
    if (object === null) return null
    assertObjectShape(digest, object)
    const fault = contentChecksumFault(digest, object)
    if (fault !== null) {
      reportAbsent(digest, fault)
      discardObjectBody(object)
      return null
    }
    return { body: object.body }
  },
  async has(digest) {
    const object = await bucket.head(digest)
    if (object === null) return false
    assertObjectShape(digest, object)
    const fault = contentChecksumFault(digest, object)
    if (fault === null) return true
    reportAbsent(digest, fault)
    return false
  },
  async put(digest, bytes) {
    const options = {
      httpMetadata: { contentType: "application/octet-stream" },
      sha256: digestBytes(digest)
    } as const
    for (let attempt = 0; attempt < maxPublicationAttempts; attempt += 1) {
      const object = await bucket.put(digest, bytes, {
        ...options,
        onlyIf: new Headers({ "if-none-match": "*" })
      })
      if (object !== null) {
        assertContentObject(digest, object)
        return "inserted"
      }
      const existing = await bucket.head(digest)
      if (existing === null) continue
      try {
        assertContentObject(digest, existing)
        return "present"
      } catch {
        // A conditional miss proves an object owns this digest, but an absent
        // or mismatched provider checksum means it is not CAS content. The
        // request body was already address-verified by the protocol, so an
        // unconditional write is a deterministic repair. A concurrent repair
        // writes the same bytes and checksum and is therefore harmless.
        const repaired = await bucket.put(digest, bytes, options)
        if (repaired === null) {
          throw new CacheFailure(
            "R2_REPAIR_MISSING",
            "contentStore.put",
            "R2 did not return the repaired content object"
          )
        }
        assertContentObject(digest, repaired)
        return "inserted"
      }
    }
    throw new CacheFailure(
      "R2_PUBLICATION_LOST",
      "contentStore.put",
      "R2 conditional publication lost its object repeatedly"
    )
  },
  async presentDigests(digests) {
    const present = new Set<string>()
    for (let offset = 0; offset < digests.length; offset += findMissingConcurrency) {
      const batch = digests.slice(offset, offset + findMissingConcurrency)
      const probes = await Promise.all(
        batch.map(async (digest) => ({ digest, object: await bucket.head(digest) }))
      )
      for (const { digest, object } of probes) {
        if (object === null) continue
        assertObjectShape(digest, object)
        const fault = contentChecksumFault(digest, object)
        if (fault === null) {
          present.add(digest)
          continue
        }
        // One unverifiable object must not fail the whole batch: the client
        // needs the rest of the answer, and reporting this digest missing is
        // what makes it republish the bytes that repair the object.
        reportAbsent(digest, fault)
      }
    }
    return present
  }
})

/**
 * Adapts the two Rate Limiting bindings to the per-credential budget contract.
 *
 * Both are keyed by the SHA-256 the handler already computed to classify the
 * credential, never by the bearer value, so the bindings' counters hold no
 * secret. `findMissing` draws on the tighter binding because one probe fans
 * out to up to a thousand metered R2 calls. An outcome that does not say
 * `success` is a refusal: a budget the platform cannot vouch for admits
 * nothing.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeCredentialBudget = (requests: RateLimit, findMissing: RateLimit): CredentialBudget => ({
  async charge(credentialDigest, route) {
    const binding = route === "findMissing" ? findMissing : requests
    const outcome = await binding.limit({ key: credentialDigest })
    return outcome.success === true
  }
})

/**
 * Deletes action-cache entries last read before `cutoff`, in bounded batches.
 *
 * `cutoff` is an ISO-8601 instant in the same rendering the table stores, so
 * the comparison is the lexicographic one the `last_accessed_at` index
 * supports. One invocation removes at most twenty batches; the next scheduled
 * run continues from where this one stopped.
 *
 * @category storage
 * @since 0.1.0
 */
export const pruneStaleEntries = async (database: D1Database, cutoff: string): Promise<number> => {
  let removed = 0
  for (let batch = 0; batch < maxRetentionBatches; batch += 1) {
    const deleted = await database
      .prepare(
        `DELETE FROM smithers_build_cache_entry
        WHERE key_digest IN (
          SELECT key_digest FROM smithers_build_cache_entry
          WHERE last_accessed_at < ?
          ORDER BY last_accessed_at
          LIMIT ?
        )
        RETURNING key_digest`
      )
      .bind(cutoff, retentionBatchRows)
      .all<KeyRow>()
    const count = deleted.results.length
    removed += count
    if (count < retentionBatchRows) break
  }
  return removed
}

const makeHealth = (database: D1Database, bucket: R2Bucket) => async (): Promise<void> => {
  const [row] = await Promise.all([
    database.prepare("SELECT 1 AS ok").first<HealthRow>(),
    bucket.head(healthObjectKey)
  ])
  if (row?.ok !== 1) {
    throw new CacheFailure("D1_READINESS_INVALID", "health", "D1 readiness check did not return its sentinel")
  }
}

type CacheHandler = ReturnType<typeof createHandler>

let isolateHandler: CacheHandler | null = null

const handlerFor = (env: CacheWorkerEnv): CacheHandler => {
  if (isolateHandler !== null) return isolateHandler
  isolateHandler = createHandler({
    actionCache: makeActionCache(env.CACHE_DATABASE),
    contentStore: makeContentStore(env.CACHE_BUCKET),
    readTokenHash: env.CACHE_READ_TOKEN,
    writeTokenHash: env.CACHE_WRITE_TOKEN,
    credentialBudget: makeCredentialBudget(env.CACHE_REQUEST_BUDGET, env.CACHE_FIND_MISSING_BUDGET),
    health: makeHealth(env.CACHE_DATABASE, env.CACHE_BUCKET)
  })
  return isolateHandler
}

/**
 * Cloudflare Worker entry point for the hosted remote cache.
 *
 * @category runtime
 * @since 0.1.0
 */
const worker = {
  async fetch(request: Request, env: CacheWorkerEnv): Promise<Response> {
    try {
      return await handlerFor(env)(request)
    } catch (cause) {
      console.error(describeFailure(cause))
      return new Response(JSON.stringify({ error: "the cache tier failed to initialize" }), {
        status: 503,
        headers: { "content-type": "application/json", "Smithers-Cache-Contract": "result-only-v1" }
      })
    }
  },
  async scheduled(_controller: ScheduledController, env: CacheWorkerEnv): Promise<void> {
    const cutoff = new Date(Date.now() - retentionDays * millisecondsPerDay).toISOString()
    try {
      const removed = await pruneStaleEntries(env.CACHE_DATABASE, cutoff)
      console.log(`smithers build cache: pruned ${removed} action-cache entries last read before ${cutoff}`)
    } catch (cause) {
      // The allowlisted diagnostic is the record; the rethrown failure is what
      // makes Cloudflare retry the invocation without repeating the cause.
      console.error(
        describeFailure(new CacheFailure("RETENTION_FAILED", "retention", "scheduled retention failed", { cause }))
      )
      throw new Error("scheduled retention failed")
    }
  }
} satisfies ExportedHandler<CacheWorkerEnv>

export default worker
