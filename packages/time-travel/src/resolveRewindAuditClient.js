/** @typedef {import("@smithers/db/adapter").SmithersDb} SmithersDb */

/**
 * Resolve the Bun SQLite client from a {@link SmithersDb} instance for audit writes.
 *
 * @param {SmithersDb} adapter
 */
export function resolveRewindAuditClient(adapter) {
  const db = /** @type {any} */ (adapter)?.db;
  const client = db?.session?.client ?? db?.$client;
  if (!client || typeof client.query !== "function") {
    throw new TypeError(
      "Could not resolve a Bun SQLite client for rewind audit writes.",
    );
  }
  return client;
}
