import type { D1Database } from "../d1.ts";

/**
 * Three times the five-minute upstream deadline in handleAnthropic: by then
 * the call has ended and its metering has either settled or given up.
 */
export const HOLD_LIFETIME_MS = 15 * 60_000;

/**
 * Settle this repository's unresolved holds older than {@link HOLD_LIFETIME_MS}
 * at their full reserved cost, which bounds the call's real spend. The usage
 * event keeps the admission time, so the charge stays in the month the call
 * ran; any usage already observed for the call is topped up, never repeated.
 * Rows with a pending settlement payload belong to retryUsage.
 */
export async function expireHolds(db: D1Database, repo: string, now: number): Promise<number> {
  const expired = await db
    .prepare(
      "SELECT id FROM usage_reservations WHERE repo = ? AND settlement_json IS NULL AND created_at <= ? LIMIT 16",
    )
    .bind(repo, now - HOLD_LIFETIME_MS)
    .all<{ id: string }>();
  if (expired.results.length === 0) return 0;
  // Every statement reads the reservation row, and the DELETE runs last, so a
  // concurrent settlement of the same hold finds no row and changes nothing.
  const unbooked = `SELECT MAX(0, r.cost_usd - COALESCE(e.cost_usd, 0)) FROM usage_reservations r
    LEFT JOIN usage_events e ON e.id = r.id WHERE r.id = ?1`;
  const statements = expired.results.flatMap(({ id }) => [
    db
      .prepare(
        `UPDATE sessions SET spent_usd = spent_usd + (${unbooked})
      WHERE hash = (SELECT session_hash FROM usage_reservations WHERE id = ?1)`,
      )
      .bind(id),
    db
      .prepare(
        `INSERT INTO usage_totals (repo, model, cost_usd)
      SELECT r.repo, COALESCE(e.model, r.model, 'unknown'), MAX(0, r.cost_usd - COALESCE(e.cost_usd, 0))
      FROM usage_reservations r LEFT JOIN usage_events e ON e.id = r.id WHERE r.id = ?1
      ON CONFLICT(repo, model) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd`,
      )
      .bind(id),
    db
      .prepare(
        `INSERT INTO usage_events (id, repo, pr, model, input_tokens, output_tokens, cost_usd, kind, created_at)
      SELECT r.id, r.repo, COALESCE(s.pr, 0), COALESCE(r.model, 'unknown'), 0, 0, r.cost_usd, 'expired_hold', r.created_at
      FROM usage_reservations r LEFT JOIN sessions s ON s.hash = r.session_hash WHERE r.id = ?1
      ON CONFLICT(id) DO UPDATE SET cost_usd = MAX(cost_usd, excluded.cost_usd)`,
      )
      .bind(id),
    db.prepare("DELETE FROM usage_reservations WHERE id = ?1").bind(id),
  ]);
  const results = await db.batch(statements);
  const settled = results.filter((_, i) => i % 4 === 3).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
  if (settled > 0) {
    console.warn("smithers-review: expired budget holds settled at reserved cost", { repo, settled });
  }
  return settled;
}
