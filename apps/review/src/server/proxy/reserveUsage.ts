import type { D1Database } from "../d1.ts";

/** One atomic INSERT checks and reserves BOTH budgets, including outstanding calls. */
export async function reserveUsage(
  db: D1Database,
  options: {
    requestId: string;
    repo: string;
    sessionHash: string | null;
    model: string;
    repoCapUsd: number | null;
    costUsd: number;
    now: number;
  },
): Promise<boolean> {
  const date = new Date(options.now);
  const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const result = await db
    .prepare(
      `INSERT INTO usage_reservations (id, repo, session_hash, cost_usd, created_at, model)
    SELECT ?1, ?2, ?3, ?4, ?5, ?8
    WHERE NOT EXISTS (SELECT 1 FROM usage_events WHERE id = ?1)
      AND (SELECT COUNT(*) FROM usage_reservations WHERE repo = ?2) < 4
      AND (?3 IS NULL OR EXISTS (
        SELECT 1 FROM sessions WHERE hash = ?3 AND repo = ?2 AND expires_at > ?5
          AND spent_usd + ?4 + (SELECT COALESCE(SUM(cost_usd), 0) FROM usage_reservations WHERE session_hash = ?3) <= spend_cap_usd
      ))
      AND (?6 IS NULL OR (
        (SELECT COALESCE(SUM(cost_usd), 0) FROM usage_events WHERE repo = ?2 AND created_at >= ?7)
        + (SELECT COALESCE(SUM(cost_usd), 0) FROM usage_reservations WHERE repo = ?2)
        + ?4 <= ?6
      )) ON CONFLICT(id) DO NOTHING`,
    )
    .bind(
      options.requestId,
      options.repo,
      options.sessionHash,
      options.costUsd,
      options.now,
      options.repoCapUsd,
      monthStart,
      options.model,
    )
    .run();
  return result.meta.changes === 1;
}
