import type { ReviewWorkerEnv } from "../env.ts";
import { jsonError } from "../jsonError.ts";
import { monthKey as monthKeyOf } from "../monthKey.ts";
import { timingSafeStringEqual } from "../timingSafeStringEqual.ts";

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

interface TotalsRow {
  repo: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
}

interface PrCountRow {
  repo: string;
  c: number;
}

interface QuotaRow {
  repo: string;
  prs_per_month: number;
}

/**
 * GET /metrics — Prometheus text exposition read from D1 rollups. Auth is the
 * bearer METRICS_TOKEN (constant-time compared). All series are intentionally
 * narrow-cardinality: repo, model, kind, status.
 */
export async function handleMetrics(request: Request, env: ReviewWorkerEnv): Promise<Response> {
  const expected = `Bearer ${env.METRICS_TOKEN ?? ""}`;
  const got = request.headers.get("authorization") ?? "";
  if (!env.METRICS_TOKEN || !timingSafeStringEqual(got, expected)) {
    return jsonError(401, "unauthorized");
  }

  const monthKey = monthKeyOf(Date.now());

  // usage_totals is maintained at settlement (recordUsage) and backfilled once
  // by ensureSchema, so this read is bounded by distinct (repo, model) pairs
  // rather than by the size of the append-only usage_events log.
  const totalsRes = await env.DB.prepare(
    "SELECT repo, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd FROM usage_totals ORDER BY repo, model",
  ).all<TotalsRow>();
  const prsRes = await env.DB.prepare("SELECT repo, COUNT(*) AS c FROM reviewed_prs GROUP BY repo").all<PrCountRow>();
  const monthPrsRes = await env.DB.prepare("SELECT repo, COUNT(*) AS c FROM reviewed_prs WHERE month = ? GROUP BY repo")
    .bind(monthKey)
    .all<PrCountRow>();
  const quotaRes = await env.DB.prepare("SELECT repo, prs_per_month FROM repos").all<QuotaRow>();

  const lines: string[] = [];
  lines.push("# HELP review_tokens_total Anthropic token usage by repo, model, kind");
  lines.push("# TYPE review_tokens_total counter");
  for (const row of totalsRes.results) {
    const base = `repo="${escapeLabel(row.repo)}",model="${escapeLabel(row.model)}"`;
    lines.push(`review_tokens_total{${base},kind="input"} ${row.input_tokens ?? 0}`);
    lines.push(`review_tokens_total{${base},kind="output"} ${row.output_tokens ?? 0}`);
    lines.push(`review_tokens_total{${base},kind="cache_write"} ${row.cache_creation_tokens ?? 0}`);
    lines.push(`review_tokens_total{${base},kind="cache_read"} ${row.cache_read_tokens ?? 0}`);
  }

  lines.push("# HELP review_spend_usd_total Estimated Anthropic spend (USD), per repo and model");
  lines.push("# TYPE review_spend_usd_total counter");
  for (const row of totalsRes.results) {
    const labels = `repo="${escapeLabel(row.repo)}",model="${escapeLabel(row.model)}"`;
    lines.push(`review_spend_usd_total{${labels}} ${row.cost_usd ?? 0}`);
  }

  lines.push("# HELP review_prs_reviewed_total Distinct PRs reviewed (all-time)");
  lines.push("# TYPE review_prs_reviewed_total counter");
  for (const row of prsRes.results) {
    lines.push(`review_prs_reviewed_total{repo="${escapeLabel(row.repo)}"} ${row.c}`);
  }

  lines.push("# HELP review_quota_remaining PRs remaining in the calendar month");
  lines.push("# TYPE review_quota_remaining gauge");
  const usedByRepo = new Map<string, number>();
  for (const row of monthPrsRes.results) usedByRepo.set(row.repo, row.c);
  for (const row of quotaRes.results) {
    const used = usedByRepo.get(row.repo) ?? 0;
    const remaining = Math.max(0, row.prs_per_month - used);
    lines.push(`review_quota_remaining{repo="${escapeLabel(row.repo)}"} ${remaining}`);
  }

  return new Response(`${lines.join("\n")}\n`, {
    status: 200,
    headers: { "content-type": "text/plain; version=0.0.4" },
  });
}
