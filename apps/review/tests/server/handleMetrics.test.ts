import { describe, expect, test } from "bun:test";
import type { D1Database } from "../../src/server/d1.ts";
import { ensureSchema } from "../../src/server/migrations.ts";
import { recordUsage } from "../../src/server/proxy/recordUsage.ts";
import { createReviewWorker } from "../../src/server/worker.ts";
import { buildTestEnv } from "./helpers/buildTestEnv.ts";
import { sqliteD1 } from "./helpers/sqliteD1.ts";

const REPO = "octo/widgets";

function makeWorker() {
  return createReviewWorker({
    jwksUrl: "http://unused",
    anthropicBaseUrl: "http://unused",
    fetchUpstream: fetch,
    now: () => Date.now(),
    waitUntil: () => undefined,
  });
}

describe("GET /metrics", () => {
  test("401 without the metrics bearer", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();
    const res = await worker.fetch(new Request("https://review.test/metrics"), env);
    expect(res.status).toBe(401);
  });

  test("emits Prometheus series for tokens, spend, prs, and quota", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();
    // Seed: one registered repo, one reviewed PR this month, one usage row.
    await env.DB.prepare(
      "INSERT INTO repos (repo, mode, prs_per_month, spend_cap_usd, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(REPO, "auto", 5, 25, Date.now())
      .run();
    const monthKey = new Date().toISOString().slice(0, 7);
    await env.DB.prepare("INSERT INTO reviewed_prs (repo, pr, month, first_seen_at) VALUES (?, ?, ?, ?)")
      .bind(REPO, 1, monthKey, Date.now())
      .run();
    // Usage goes through the real settlement path so the rollup /metrics reads is maintained.
    await recordUsage(env.DB, {
      requestId: "e1",
      sessionHash: null,
      repo: REPO,
      pr: 1,
      summary: { model: "claude-sonnet-4-6", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 200, cacheReadTokens: 4000 },
      kind: "messages",
      now: Date.now(),
    });
    const res = await worker.fetch(
      new Request("https://review.test/metrics", { headers: { authorization: "Bearer test-metrics" } }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('review_tokens_total{repo="octo/widgets",model="claude-sonnet-4-6",kind="input"} 100');
    expect(body).toContain('review_tokens_total{repo="octo/widgets",model="claude-sonnet-4-6",kind="output"} 50');
    // Cache tokens dominate cache-heavy agent workloads; they must be visible too.
    expect(body).toContain('review_tokens_total{repo="octo/widgets",model="claude-sonnet-4-6",kind="cache_write"} 200');
    expect(body).toContain('review_tokens_total{repo="octo/widgets",model="claude-sonnet-4-6",kind="cache_read"} 4000');
    expect(body).toContain('review_spend_usd_total{repo="octo/widgets",model="claude-sonnet-4-6"}');
    expect(body).toContain('review_prs_reviewed_total{repo="octo/widgets"} 1');
    expect(body).toContain('review_quota_remaining{repo="octo/widgets"} 4');
    // Never-emitted series were removed; stale HELP/TYPE headers must not linger.
    expect(body).not.toContain("review_proxy_errors_total");
    expect(body).not.toContain("review_sessions_total");
  });

  test("serves token and spend series from bounded per-(repo, model) totals, never the event log", async () => {
    // Pre-rollup database: usage_events rows exist before the totals table does.
    const db = sqliteD1();
    await db.exec(`CREATE TABLE usage_events (
      id TEXT PRIMARY KEY, repo TEXT NOT NULL, pr INTEGER NOT NULL, model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL
    )`);
    const seed = [
      ["e1", REPO, "claude-sonnet-4-6", 100, 50, 200, 4000, 0.001],
      ["e2", REPO, "claude-sonnet-4-6", 10, 5, 20, 400, 0.0001],
      ["e3", REPO, "claude-opus-4-6", 7, 3, 0, 0, 0.002],
      ["e4", "octo/other", "claude-sonnet-4-6", 1, 1, 1, 1, 0.00001],
    ];
    for (const row of seed) {
      await db
        .prepare(
          "INSERT INTO usage_events (id, repo, pr, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd, kind, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 'messages', 1)",
        )
        .bind(...row)
        .run();
    }
    // Backfill runs inside the migration and is idempotent across worker instances.
    await ensureSchema(db);
    await ensureSchema({ prepare: (q) => db.prepare(q), exec: (q) => db.exec(q), batch: (s) => db.batch(s) });
    await db.prepare("INSERT INTO sessions (hash, repo, pr, expires_at, spend_cap_usd, created_at) VALUES ('s', ?, 1, ?, 1, 1)")
      .bind(REPO, Date.now() + 60_000)
      .run();
    // New settlements keep the totals current; a replayed request id counts once.
    const settle = (requestId: string, model: string, inputTokens: number) =>
      recordUsage(db, {
        requestId,
        sessionHash: "s",
        repo: REPO,
        pr: 1,
        summary: { model, inputTokens, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4 },
        kind: "messages",
        now: Date.now(),
      });
    await settle("n1", "claude-sonnet-4-6", 1000);
    await settle("n1", "claude-sonnet-4-6", 1000);
    await settle("n2", "claude-haiku-4-5", 5);

    const expected = await db
      .prepare(
        "SELECT repo, model, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cache_creation_tokens) AS cache_creation_tokens, SUM(cache_read_tokens) AS cache_read_tokens, SUM(cost_usd) AS cost_usd FROM usage_events GROUP BY repo, model ORDER BY repo, model",
      )
      .all();
    expect(expected.results).toHaveLength(4);
    const totals = await db
      .prepare(
        "SELECT repo, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd FROM usage_totals ORDER BY repo, model",
      )
      .all();
    expect(totals.results).toEqual(expected.results);

    const queries: string[] = [];
    const spied: D1Database = {
      prepare: (q) => {
        queries.push(q);
        return db.prepare(q);
      },
      exec: (q) => db.exec(q),
      batch: (s) => db.batch(s),
    };
    // The worker ensures the schema per DB instance; a third backfill must not double count either.
    await ensureSchema(spied);
    queries.length = 0;
    const env = { ...(await buildTestEnv()), DB: spied };
    const res = await makeWorker().fetch(
      new Request("https://review.test/metrics", { headers: { authorization: "Bearer test-metrics" } }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('review_tokens_total{repo="octo/widgets",model="claude-sonnet-4-6",kind="input"} 1110');
    expect(body).toContain('review_tokens_total{repo="octo/widgets",model="claude-sonnet-4-6",kind="cache_read"} 4404');
    expect(body).toContain('review_tokens_total{repo="octo/widgets",model="claude-haiku-4-5",kind="input"} 5');
    expect(body).toContain('review_tokens_total{repo="octo/other",model="claude-sonnet-4-6",kind="output"} 1');
    expect(body).toContain('review_spend_usd_total{repo="octo/widgets",model="claude-opus-4-6"} 0.002');
    // The scrape must be bounded by the number of (repo, model) pairs, not by service lifetime.
    expect(queries.filter((q) => /usage_events/i.test(q))).toEqual([]);
    expect(queries.filter((q) => /usage_totals/i.test(q))).toHaveLength(1);
  });
});
