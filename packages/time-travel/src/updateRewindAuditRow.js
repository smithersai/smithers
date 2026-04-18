import { resolveRewindAuditClient } from "./resolveRewindAuditClient.js";

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("./RewindAuditResult.ts").RewindAuditResult} RewindAuditResult */

/**
 * Update an existing rewind audit row's result and duration.
 * Used to mark an `in_progress` row as `success`, `failed`, or `partial`.
 *
 * @param {SmithersDb} adapter
 * @param {{ id: number; result: RewindAuditResult; durationMs?: number | null; fromFrameNo?: number }} row
 */
export async function updateRewindAuditRow(adapter, row) {
  const client = resolveRewindAuditClient(adapter);
  if (typeof row.fromFrameNo === "number") {
    client
      .query(
        `UPDATE _smithers_time_travel_audit
            SET result = ?,
                duration_ms = ?,
                from_frame_no = ?
          WHERE id = ?`,
      )
      .run(row.result, row.durationMs ?? null, row.fromFrameNo, row.id);
    return;
  }
  client
    .query(
      `UPDATE _smithers_time_travel_audit
          SET result = ?,
              duration_ms = ?
        WHERE id = ?`,
    )
    .run(row.result, row.durationMs ?? null, row.id);
}
