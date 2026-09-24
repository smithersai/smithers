import type { ReviewWorkerEnv } from "../env.ts";
import { jsonError } from "../jsonError.ts";
import { timingSafeStringEqual } from "../timingSafeStringEqual.ts";

interface UsageRow {
  day: string;
  repo: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

/**
 * GET /api/admin/usage — daily summary of usage_events by repo/model. The day
 * bucket uses UTC midnight; matches the dashboards' own grouping so the
 * numbers line up.
 */
export async function handleAdminUsage(request: Request, env: ReviewWorkerEnv, now = Date.now()): Promise<Response> {
  const expected = `Bearer ${env.ADMIN_TOKEN ?? ""}`;
  const got = request.headers.get("authorization") ?? "";
  if (!env.ADMIN_TOKEN || !timingSafeStringEqual(got, expected)) {
    return jsonError(401, "unauthorized");
  }
  if (request.method !== "GET") return jsonError(405, "method not allowed");
  const days = Number(new URL(request.url).searchParams.get("days") ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > 90) return jsonError(400, "days must be between 1 and 90");
  const rows = await env.DB.prepare(
    `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day,
              repo, model,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cost_usd) AS cost_usd
       FROM usage_events WHERE created_at >= ? AND created_at <= ?
       GROUP BY day, repo, model
       ORDER BY day DESC, repo, model`,
  ).bind(now - days * 86400000, now).all<UsageRow>();
  return Response.json({
    days: rows.results.map((r) => ({
      day: r.day,
      repo: r.repo,
      model: r.model,
      inputTokens: r.input_tokens ?? 0,
      outputTokens: r.output_tokens ?? 0,
      costUsd: r.cost_usd ?? 0,
    })),
  });
}
