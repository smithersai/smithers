/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */

/**
 * Minimal Bun SQLite client surface used by the rewind audit helpers.
 * This mirrors the shape returned by `bun:sqlite`'s `Database.query()`
 * and is sufficient for the raw SQL writes / reads we perform against
 * the `_smithers_time_travel_audit` and `_smithers_frames` tables.
 *
 * @typedef {{
 *   query: (sql: string) => {
 *     run: (...args: unknown[]) => unknown;
 *     get: (...args: unknown[]) => Record<string, unknown> | null | undefined;
 *     all: (...args: unknown[]) => Array<Record<string, unknown>>;
 *   };
 * }} RewindAuditSqliteClient
 */

/**
 * Resolve the Bun SQLite client from a {@link SmithersDb} instance for audit writes.
 *
 * @param {SmithersDb} adapter
 * @returns {RewindAuditSqliteClient}
 */
export function resolveRewindAuditClient(adapter) {
  const db = /** @type {{ session?: { client?: unknown }; $client?: unknown } | null | undefined} */ (
    /** @type {unknown} */ (adapter?.db)
  );
  const candidate = /** @type {unknown} */ (db?.session?.client ?? db?.$client);
  if (
    !candidate ||
    typeof (/** @type {{ query?: unknown }} */ (candidate).query) !== "function"
  ) {
    throw new TypeError(
      "Could not resolve a Bun SQLite client for rewind audit writes.",
    );
  }
  return /** @type {RewindAuditSqliteClient} */ (candidate);
}
