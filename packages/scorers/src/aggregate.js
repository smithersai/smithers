// @smithers-type-exports-begin
/** @typedef {import("./aggregate.ts").AggregateOptions} AggregateOptions */
// @smithers-type-exports-end

/**
 * Computes aggregate statistics for scorer results.
 *
 * Returns one row per scorer with count, mean, min, max, p50, and stddev.
 * Uses a simple SQL aggregation query plus in-memory p50 calculation,
 * since SQLite does not support PERCENTILE_CONT or correlated subqueries
 * in GROUP BY reliably.
 */
export async function aggregateScores(adapter, opts) {
    const conditions = [];
    if (opts?.runId)
        conditions.push(`run_id = '${escapeSql(opts.runId)}'`);
    if (opts?.nodeId)
        conditions.push(`node_id = '${escapeSql(opts.nodeId)}'`);
    if (opts?.scorerId)
        conditions.push(`scorer_id = '${escapeSql(opts.scorerId)}'`);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
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
    const aggRows = (await adapter.rawQuery(aggQuery));
    if (aggRows.length === 0)
        return [];
    // Step 2: Get all scores to compute p50 and stddev per scorer in memory
    const scoresQuery = `
    SELECT scorer_id, score
    FROM _smithers_scorers
    ${where}
    ORDER BY scorer_id, score
  `;
    const allScores = (await adapter.rawQuery(scoresQuery));
    // Group scores by scorer_id
    const scoresByScorer = new Map();
    for (const row of allScores) {
        const id = row.scorer_id;
        if (!scoresByScorer.has(id))
            scoresByScorer.set(id, []);
        scoresByScorer.get(id).push(Number(row.score));
    }
    return aggRows.map((row) => {
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
/**
 * @param {number[]} sorted
 * @returns {number}
 */
function computeMedian(sorted) {
    if (sorted.length === 0)
        return 0;
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
}
/**
 * @param {number[]} values
 * @param {number} mean
 * @returns {number}
 */
function computeStddev(values, mean) {
    if (values.length <= 1)
        return 0;
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance);
}
/**
 * @param {string} value
 * @returns {string}
 */
function escapeSql(value) {
    return value.replace(/'/g, "''");
}
