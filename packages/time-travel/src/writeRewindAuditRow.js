import { resolveRewindAuditClient } from "./resolveRewindAuditClient.js";

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("./RewindAuditResult.ts").RewindAuditResult} RewindAuditResult */

/**
 * Persist one audit row for a jump-to-frame attempt.
 *
 * @param {SmithersDb} adapter
 * @param {{
 *   runId: string;
 *   fromFrameNo: number;
 *   toFrameNo: number;
 *   caller: string;
 *   timestampMs: number;
 *   result: RewindAuditResult;
 *   durationMs?: number | null;
 * }} row
 * @returns {Promise<number | null>}
 */
export async function writeRewindAuditRow(adapter, row) {
  const client = resolveRewindAuditClient(adapter);
  client
    .query(
      `INSERT INTO _smithers_time_travel_audit (
         run_id,
         from_frame_no,
         to_frame_no,
         caller,
         timestamp_ms,
         result,
         duration_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.runId,
      row.fromFrameNo,
      row.toFrameNo,
      row.caller,
      row.timestampMs,
      row.result,
      row.durationMs ?? null,
    );
  const inserted = client.query("SELECT last_insert_rowid() AS id").get();
  return typeof inserted?.id === "number" ? inserted.id : null;
}
