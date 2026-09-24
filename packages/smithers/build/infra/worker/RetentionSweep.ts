/**
 * Scheduled retention for the D1 action cache.
 *
 * @since 0.1.0
 */

interface KeyRow {
  readonly key_digest: string
}

const retentionBatchRows = 500

/**
 * How long one retention invocation keeps deleting.
 *
 * The budget stays well inside a daily cron invocation's wall-clock limit.
 * An invocation that spends it reports a backlog instead of stopping silently.
 *
 * @category constants
 * @since 0.1.0
 */
export const retentionBudgetMs = 60_000

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
 * What one retention invocation did.
 *
 * `backlog` is true when the invocation stopped at its time budget with rows
 * still past the cutoff; the next scheduled run continues from there.
 *
 * @category models
 * @since 0.1.0
 */
export interface RetentionResult {
  readonly removed: number
  readonly backlog: boolean
}

/**
 * Substitutions for the retention clock.
 *
 * @category models
 * @since 0.1.0
 */
export interface RetentionOptions {
  readonly now?: (() => number) | undefined
  readonly budgetMs?: number | undefined
}

/**
 * Deletes action-cache entries last read before `cutoff`, in bounded batches.
 *
 * `cutoff` is an ISO-8601 instant in the same rendering the table stores, so
 * the comparison is the lexicographic one the `last_accessed_at` index
 * supports. Batches continue until one comes back short or the time budget is
 * spent; the next scheduled run continues from where this one stopped.
 *
 * @category storage
 * @since 0.1.0
 */
export const pruneStaleEntries = async (
  database: D1Database,
  cutoff: string,
  options: RetentionOptions = {}
): Promise<RetentionResult> => {
  const now = options.now ?? Date.now
  const deadline = now() + (options.budgetMs ?? retentionBudgetMs)
  let removed = 0
  for (;;) {
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
    if (count < retentionBatchRows) return { removed, backlog: false }
    if (now() >= deadline) return { removed, backlog: true }
  }
}
