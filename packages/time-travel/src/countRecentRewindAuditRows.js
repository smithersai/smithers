import { resolveRewindAuditClient } from "./resolveRewindAuditClient.js";

/** @typedef {import("@smithers/db/adapter").SmithersDb} SmithersDb */

/**
 * Count audit rows for one caller and run in a time window.
 * Only counts terminal (non-in_progress) rows so that a live attempt
 * does not itself blow the rate-limit quota.
 *
 * @param {SmithersDb} adapter
 * @param {{ runId: string; caller: string; sinceMs: number; }} input
 * @returns {Promise<number>}
 */
export async function countRecentRewindAuditRows(adapter, input) {
  const client = resolveRewindAuditClient(adapter);
  const row = client
    .query(
      `SELECT COUNT(*) AS count
         FROM _smithers_time_travel_audit
        WHERE run_id = ?
          AND caller = ?
          AND timestamp_ms >= ?
          AND result <> 'in_progress'`,
    )
    .get(input.runId, input.caller, input.sinceMs);
  return Number(row?.count ?? 0);
}
