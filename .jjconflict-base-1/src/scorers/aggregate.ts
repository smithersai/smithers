import type { SmithersDb } from "../db/adapter";
import type { AggregateScore } from "./types";

export type AggregateOptions = {
  /** Filter to a specific run. */
  runId?: string;
  /** Filter to a specific node. */
  nodeId?: string;
  /** Filter to a specific scorer. */
  scorerId?: string;
};

/**
 * Computes aggregate statistics for scorer results.
 *
 * Returns one row per scorer with count, mean, min, max, p50, and stddev.
 * Uses a simple SQL aggregation query plus in-memory p50 calculation,
 * since SQLite does not support PERCENTILE_CONT or correlated subqueries
 * in GROUP BY reliably.
 */
export async function aggregateScores(
  adapter: SmithersDb,
  opts?: AggregateOptions,
): Promise<AggregateScore[]> {
  const conditions: string[] = [];
  if (opts?.runId) conditions.push(`run_id = '${escapeSql(opts.runId)}'`);
  if (opts?.nodeId) conditions.push(`node_id = '${escapeSql(opts.nodeId)}'`);
  if (opts?.scorerId)
    conditions.push(`scorer_id = '${escapeSql(opts.scorerId)}'`);

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Step 1: Get aggregate stats via SQL
  const aggQuery = `
    SELECT
      scorer_id,
      scorer_name,
      COUNT(*) AS cnt,
      AVG(score) AS mean,
      MIN(score) AS min_score,
      MAX(score) AS max_score
    FROM _smithers_scorers
    ${where}
    GROUP BY scorer_id, scorer_name
    ORDER BY scorer_name
  `;

  const aggRows = (await adapter.rawQuery(aggQuery)) as any[];
  if (aggRows.length === 0) return [];

  // Step 2: Get all scores to compute p50 and stddev per scorer in memory
  const scoresQuery = `
    SELECT scorer_id, score
    FROM _smithers_scorers
    ${where}
    ORDER BY scorer_id, score
  `;

  const allScores = (await adapter.rawQuery(scoresQuery)) as any[];

  // Group scores by scorer_id
  const scoresByScorer = new Map<string, number[]>();
  for (const row of allScores) {
    const id = row.scorer_id;
    if (!scoresByScorer.has(id)) scoresByScorer.set(id, []);
    scoresByScorer.get(id)!.push(Number(row.score));
  }

  return aggRows.map((row: any) => {
    const scores = scoresByScorer.get(row.scorer_id) ?? [];
    const p50 = computeMedian(scores);
    const mean = Number(row.mean ?? 0);
    const stddev = computeStddev(scores, mean);

    return {
      scorerId: row.scorer_id,
      scorerName: row.scorer_name,
      count: Number(row.cnt),
      mean,
      min: Number(row.min_score ?? 0),
      max: Number(row.max_score ?? 0),
      p50,
      stddev,
    };
  });
}

function computeMedian(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

function computeStddev(values: number[], mean: number): number {
  if (values.length <= 1) return 0;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}
