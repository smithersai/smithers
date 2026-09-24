import { expect, test } from "bun:test";
import { expireHolds, HOLD_LIFETIME_MS } from "../../src/server/proxy/expireHolds.ts";
import { recordUsage } from "../../src/server/proxy/recordUsage.ts";
import { buildTestEnv } from "./helpers/buildTestEnv.ts";

const REPO = "octo/widgets";
const ADMITTED = Date.UTC(2026, 8, 30, 23, 55);

async function setup() {
  const env = await buildTestEnv();
  await env.DB.prepare(
    "INSERT INTO sessions (hash, repo, pr, expires_at, spend_cap_usd, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind("session", REPO, 3, ADMITTED + 60_000, 10, ADMITTED)
    .run();
  const hold = (id: string, costUsd: number, createdAt = ADMITTED, model: string | null = "claude-sonnet-4-6") =>
    env.DB.prepare(
      "INSERT INTO usage_reservations (id, repo, session_hash, cost_usd, created_at, model) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(id, REPO, "session", costUsd, createdAt, model)
      .run();
  const spent = async () =>
    (await env.DB.prepare("SELECT spent_usd FROM sessions").first<{ spent_usd: number }>())!.spent_usd;
  return { env, hold, spent };
}

test("an interrupted call's observed usage is topped up to its reservation once", async () => {
  const { env, hold, spent } = await setup();
  await hold("partial", 0.5);
  await recordUsage(env.DB, {
    requestId: "partial",
    sessionHash: "session",
    repo: REPO,
    pr: 3,
    summary: { model: "claude-sonnet-4-6", inputTokens: 300, outputTokens: 42, cacheCreationTokens: 0, cacheReadTokens: 0 },
    kind: "messages_stream",
    now: ADMITTED + 1_000,
    retainReservation: true,
  });
  expect(await spent()).toBeCloseTo(0.00153, 9);

  const now = ADMITTED + HOLD_LIFETIME_MS;
  const racing = await Promise.all([expireHolds(env.DB, REPO, now), expireHolds(env.DB, REPO, now)]);
  expect(racing[0] + racing[1]).toBe(1);
  expect(await expireHolds(env.DB, REPO, now)).toBe(0);

  expect(await spent()).toBeCloseTo(0.5, 9);
  expect(
    await env.DB.prepare("SELECT cost_usd, kind, input_tokens, created_at FROM usage_events").all(),
  ).toMatchObject({ results: [{ cost_usd: 0.5, kind: "messages_stream", input_tokens: 300, created_at: ADMITTED + 1_000 }] });
  expect((await env.DB.prepare("SELECT cost_usd FROM usage_totals").first<{ cost_usd: number }>())?.cost_usd).toBeCloseTo(
    0.5,
    9,
  );
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_reservations").first<{ n: number }>())?.n).toBe(0);
});

test("young holds and holds awaiting a settlement retry are left alone", async () => {
  const { env, hold, spent } = await setup();
  await hold("young", 0.2, ADMITTED + 1);
  await hold("retrying", 0.3);
  await env.DB.prepare("UPDATE usage_reservations SET settlement_json = '{}' WHERE id = 'retrying'").run();

  expect(await expireHolds(env.DB, REPO, ADMITTED + HOLD_LIFETIME_MS)).toBe(0);
  expect(await spent()).toBe(0);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_reservations").first<{ n: number }>())?.n).toBe(2);
});

test("a hold admitted before the model column is booked under an unknown model", async () => {
  const { env, hold } = await setup();
  await hold("legacy", 0.25, ADMITTED, null);
  expect(await expireHolds(env.DB, REPO, ADMITTED + HOLD_LIFETIME_MS)).toBe(1);
  expect(await env.DB.prepare("SELECT model, pr, cost_usd, kind FROM usage_events").first<Record<string, unknown>>()).toEqual({
    model: "unknown",
    pr: 3,
    cost_usd: 0.25,
    kind: "expired_hold",
  });
});
