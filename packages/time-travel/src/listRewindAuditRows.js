import { resolveRewindAuditClient } from "./resolveRewindAuditClient.js";

/** @typedef {import("@smithers/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("./RewindAuditResult.ts").RewindAuditResult} RewindAuditResult */

/**
 * Fetch audit rows for tests and diagnostics.
 *
 * @param {SmithersDb} adapter
 * @param {{ runId?: string; limit?: number; }} [input]
 * @returns {Promise<Array<{ id: number; runId: string; fromFrameNo: number; toFrameNo: number; caller: string; timestampMs: number; result: RewindAuditResult; durationMs: number | null }>>}
 */
export async function listRewindAuditRows(adapter, input = {}) {
  const client = resolveRewindAuditClient(adapter);
  const limit = Number.isInteger(input.limit) ? Math.max(1, input.limit) : 100;
  if (typeof input.runId === "string") {
    return /** @type {any} */ (
      client
        .query(
          `SELECT
             id,
             run_id AS runId,
             from_frame_no AS fromFrameNo,
             to_frame_no AS toFrameNo,
             caller,
             timestamp_ms AS timestampMs,
             result,
             duration_ms AS durationMs
           FROM _smithers_time_travel_audit
           WHERE run_id = ?
           ORDER BY id ASC
           LIMIT ?`,
        )
        .all(input.runId, limit)
    );
  }
  return /** @type {any} */ (
    client
      .query(
        `SELECT
           id,
           run_id AS runId,
           from_frame_no AS fromFrameNo,
           to_frame_no AS toFrameNo,
           caller,
           timestamp_ms AS timestampMs,
           result,
           duration_ms AS durationMs
         FROM _smithers_time_travel_audit
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(limit)
  );
}
