import { resolveRewindAuditClient } from "./resolveRewindAuditClient.js";

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("./RewindAuditResult.ts").RewindAuditResult} RewindAuditResult */

/**
 * @typedef {{
 *   id: number;
 *   runId: string;
 *   fromFrameNo: number;
 *   toFrameNo: number;
 *   caller: string;
 *   timestampMs: number;
 *   result: RewindAuditResult;
 *   durationMs: number | null;
 * }} RewindAuditRow
 */

/**
 * @param {Array<Record<string, unknown>>} rows
 * @returns {Array<RewindAuditRow>}
 */
function mapRewindAuditRows(rows) {
  return rows.map((row) => ({
    id: Number(row.id),
    runId: String(row.runId),
    fromFrameNo: Number(row.fromFrameNo),
    toFrameNo: Number(row.toFrameNo),
    caller: String(row.caller),
    timestampMs: Number(row.timestampMs),
    result: /** @type {RewindAuditResult} */ (String(row.result)),
    durationMs: row.durationMs == null ? null : Number(row.durationMs),
  }));
}

/**
 * Fetch audit rows for tests and diagnostics.
 *
 * @param {SmithersDb} adapter
 * @param {{ runId?: string; limit?: number; }} [input]
 * @returns {Promise<Array<RewindAuditRow>>}
 */
export async function listRewindAuditRows(adapter, input = {}) {
  const client = resolveRewindAuditClient(adapter);
  const limit = Number.isInteger(input.limit) ? Math.max(1, Number(input.limit)) : 100;
  if (typeof input.runId === "string") {
    const rows = client
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
      .all(input.runId, limit);
    return mapRewindAuditRows(rows);
  }
  const rows = client
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
    .all(limit);
  return mapRewindAuditRows(rows);
}
