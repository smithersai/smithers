import type { D1Database } from "../d1.ts";
import { PROXY_IN_FLIGHT_LIMIT } from "./proxyInFlightLimit.ts";

/**
 * Session headroom (`?3` hash, `?4` cost, `?5` now) and repository month
 * headroom (`?2` repo, `?6` cap, `?7` month start), both counting outstanding
 * reservations. The insert and the refusal classifier share it verbatim.
 */
const BUDGET_HEADROOM = `(?3 IS NULL OR EXISTS (
        SELECT 1 FROM sessions WHERE hash = ?3 AND repo = ?2 AND expires_at > ?5
          AND spent_usd + ?4 + (SELECT COALESCE(SUM(cost_usd), 0) FROM usage_reservations WHERE session_hash = ?3) <= spend_cap_usd
      ))
      AND (?6 IS NULL OR (
        (SELECT COALESCE(SUM(cost_usd), 0) FROM usage_events WHERE repo = ?2 AND created_at >= ?7)
        + (SELECT COALESCE(SUM(cost_usd), 0) FROM usage_reservations WHERE repo = ?2)
        + ?4 <= ?6
      ))`;

/**
 * `reserved`, or why admission was refused. `in_flight_limit` means the budget
 * has headroom and only {@link PROXY_IN_FLIGHT_LIMIT} outstanding calls stand
 * in the way, so the refusal clears once one settles; `spend_cap` does not.
 */
export type Reservation = "reserved" | "in_flight_limit" | "spend_cap";

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
): Promise<Reservation> {
  const date = new Date(options.now);
  const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const budget = [
    options.requestId,
    options.repo,
    options.sessionHash,
    options.costUsd,
    options.now,
    options.repoCapUsd,
    monthStart,
  ];
  const result = await db
    .prepare(
      `INSERT INTO usage_reservations (id, repo, session_hash, cost_usd, created_at, model)
    SELECT ?1, ?2, ?3, ?4, ?5, ?8
    WHERE NOT EXISTS (SELECT 1 FROM usage_events WHERE id = ?1)
      AND (SELECT COUNT(*) FROM usage_reservations WHERE repo = ?2) < ?9
      AND ${BUDGET_HEADROOM} ON CONFLICT(id) DO NOTHING`,
    )
    .bind(...budget, options.model, PROXY_IN_FLIGHT_LIMIT)
    .run();
  if (result.meta.changes === 1) return "reserved";
  // Classified after the fact, so a hold settling in between reads as headroom:
  // the error leans toward the retryable answer, and the retry re-checks both.
  const headroom = await db
    .prepare(`SELECT ${BUDGET_HEADROOM} AS ok`)
    .bind(...budget)
    .first<{ ok: number }>();
  return headroom?.ok ? "in_flight_limit" : "spend_cap";
}
