/**
 * Scheduled retention for the D1 action cache.
 *
 * @since 0.1.0
 */

interface KeyRow {
  readonly key_digest: string
}

const retentionBatchRows = 500
const maxRetentionBatches = 20

/**
 * How long an unread action-cache entry survives.
 *
 * D1 holds 10 GB per database and an entry is up to 1 MiB, so an unpruned
 * store reaches its ceiling at roughly ten thousand entries and every
 * publication after that fails. Deleting a cold entry only costs the next
 * build a cache miss, so retention is a plain time window over the
 * `last_accessed_at` index the read path maintains once per `readTouchDays`.
 *
 * @category constants
 * @since 0.1.0
 */
export const retentionDays = 30

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
