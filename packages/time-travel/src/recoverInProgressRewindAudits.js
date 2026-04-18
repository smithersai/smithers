import { resolveRewindAuditClient } from "./resolveRewindAuditClient.js";

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */

/**
 * On startup, find rewind audit rows left in `in_progress` by a prior crash,
 * mark them as `partial`, and flag the associated runs as `needs_attention`.
 *
 * @param {SmithersDb} adapter
 * @param {{ nowMs?: () => number }} [options]
 * @returns {Promise<{ recovered: Array<{ id: number; runId: string }> }>}
 */
export async function recoverInProgressRewindAudits(adapter, options = {}) {
  const nowMs = options.nowMs ?? (() => Date.now());
  const client = resolveRewindAuditClient(adapter);
  const rows = /** @type {Array<{ id: number; runId: string; timestampMs: number }>} */ (
    client
      .query(
        `SELECT id, run_id AS runId, timestamp_ms AS timestampMs
           FROM _smithers_time_travel_audit
          WHERE result = 'in_progress'`,
      )
      .all()
  );
  if (rows.length === 0) {
    return { recovered: [] };
  }
  const now = nowMs();
  const updateStmt = client.query(
    `UPDATE _smithers_time_travel_audit
        SET result = 'partial',
            duration_ms = COALESCE(duration_ms, ?)
      WHERE id = ?`,
  );
  const recovered = [];
  for (const row of rows) {
    const duration = Math.max(0, now - Number(row.timestampMs ?? now));
    updateStmt.run(duration, row.id);
    try {
      const payload = JSON.stringify({
        code: "RewindFailed",
        needsAttention: true,
        message: `Rewind audit ${row.id} was in_progress at startup; marked partial.`,
        timestampMs: now,
      });
      await adapter.updateRun(row.runId, {
        status: "needs_attention",
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        errorJson: payload,
      });
    } catch {
      try {
        await adapter.updateRun(row.runId, {
          status: "failed",
          heartbeatAtMs: null,
          runtimeOwnerId: null,
          errorJson: JSON.stringify({
            code: "RewindFailed",
            needsAttention: true,
            message: "Rewind was in_progress at startup.",
            timestampMs: now,
          }),
        });
      } catch {
        // best-effort: nothing to do if the run row was deleted.
      }
    }
    recovered.push({ id: row.id, runId: row.runId });
  }
  return { recovered };
}
