import { describe, expect, test } from "bun:test";
import { createReviewWorker } from "../../src/server/worker.ts";
import { buildTestEnv } from "./helpers/buildTestEnv.ts";

function makeWorker() {
  return createReviewWorker({
    jwksUrl: "http://unused",
    anthropicBaseUrl: "http://unused",
    fetchUpstream: fetch,
    now: () => Date.UTC(2025, 5, 3),
    waitUntil: () => undefined,
  });
}

async function insertUsageEvent(
  db: Awaited<ReturnType<typeof buildTestEnv>>["DB"],
  opts: {
    id: string;
    repo: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    createdAt: number;
  },
) {
  await db
    .prepare(
      `INSERT INTO usage_events (id, repo, pr, model, input_tokens, output_tokens, cost_usd, kind, created_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, 'review', ?)`,
    )
    .bind(opts.id, opts.repo, opts.model, opts.inputTokens, opts.outputTokens, opts.costUsd, opts.createdAt)
    .run();
}

describe("/api/admin/usage", () => {
  test("returns 401 without a valid token", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();
    const res = await worker.fetch(new Request("https://review.test/api/admin/usage"), env);
    expect(res.status).toBe(401);
  });

  test("returns 405 for non-GET methods", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();
    const res = await worker.fetch(
      new Request("https://review.test/api/admin/usage", {
        method: "POST",
        headers: { authorization: "Bearer test-admin" },
      }),
      env,
    );
    expect(res.status).toBe(405);
  });

  test("returns empty days array when no usage events exist", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();
    const res = await worker.fetch(
      new Request("https://review.test/api/admin/usage", {
        headers: { authorization: "Bearer test-admin" },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: unknown[] };
    expect(body.days).toEqual([]);
  });

  test("aggregates usage events by day, repo, and model", async () => {
    const env = await buildTestEnv();
    const worker = makeWorker();

    const day1 = new Date("2025-06-01T12:00:00Z").getTime();
    await insertUsageEvent(env.DB, {
      id: "evt-1",
      repo: "octo/widgets",
      model: "claude-sonnet-4-6",
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: 0.01,
      createdAt: day1,
    });
    await insertUsageEvent(env.DB, {
      id: "evt-2",
      repo: "octo/widgets",
      model: "claude-sonnet-4-6",
      inputTokens: 500,
      outputTokens: 100,
      costUsd: 0.005,
      createdAt: day1,
    });

    const day2 = new Date("2025-06-02T08:00:00Z").getTime();
    await insertUsageEvent(env.DB, {
      id: "evt-3",
      repo: "octo/other",
      model: "claude-haiku-4-5",
      inputTokens: 300,
      outputTokens: 50,
      costUsd: 0.002,
      createdAt: day2,
    });

    const res = await worker.fetch(
      new Request("https://review.test/api/admin/usage", {
        headers: { authorization: "Bearer test-admin" },
      }),
      env,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      days: Array<{
        day: string;
        repo: string;
        model: string;
        inputTokens: number;
        outputTokens: number;
        costUsd: number;
      }>;
    };

    expect(body.days).toHaveLength(2);
    expect(body.days[0]).toMatchObject({
      day: "2025-06-02",
      repo: "octo/other",
      model: "claude-haiku-4-5",
      inputTokens: 300,
      outputTokens: 50,
      costUsd: 0.002,
    });
    expect(body.days[1]).toMatchObject({
      day: "2025-06-01",
      repo: "octo/widgets",
      model: "claude-sonnet-4-6",
      inputTokens: 1500,
      outputTokens: 300,
      costUsd: 0.015,
    });
  });
});
