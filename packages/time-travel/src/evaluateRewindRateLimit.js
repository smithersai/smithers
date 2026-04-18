import { countRecentRewindAuditRows } from "./countRecentRewindAuditRows.js";
import { REWIND_RATE_LIMIT_MAX } from "./REWIND_RATE_LIMIT_MAX.js";
import { REWIND_RATE_LIMIT_WINDOW_MS } from "./REWIND_RATE_LIMIT_WINDOW_MS.js";

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */

/**
 * Evaluate caller-scoped rewind quota for one run.
 *
 * @param {{
 *   adapter: SmithersDb;
 *   runId: string;
 *   caller: string;
 *   nowMs?: () => number;
 *   maxPerWindow?: number;
 *   windowMs?: number;
 * }} input
 */
export async function evaluateRewindRateLimit(input) {
  const nowMs = input.nowMs ?? (() => Date.now());
  const max = Number.isInteger(input.maxPerWindow)
    ? Math.max(1, Number(input.maxPerWindow))
    : REWIND_RATE_LIMIT_MAX;
  const windowMs = Number.isInteger(input.windowMs)
    ? Math.max(1, Number(input.windowMs))
    : REWIND_RATE_LIMIT_WINDOW_MS;
  const windowStartedAtMs = nowMs() - windowMs;
  const used = await countRecentRewindAuditRows(input.adapter, {
    runId: input.runId,
    caller: input.caller,
    sinceMs: windowStartedAtMs,
  });
  return {
    limited: used >= max,
    used,
    remaining: Math.max(0, max - used),
    max,
    windowMs,
    windowStartedAtMs,
  };
}
