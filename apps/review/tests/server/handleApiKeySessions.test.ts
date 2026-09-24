import { expect, test } from "bun:test";
import { sha256Hex } from "../../src/server/sha256Hex.ts";
import { handleSessions } from "../../src/server/sessions/handleSessions.ts";
import { handleAnthropic, type HandleAnthropicDeps } from "../../src/server/proxy/handleAnthropic.ts";
import { handlePlan } from "../../src/server/plan/handlePlan.ts";
import type { ReviewWorkerEnv } from "../../src/server/env.ts";
import { buildTestEnv } from "./helpers/buildTestEnv.ts";

const NOW = Date.UTC(2026, 8, 9);
const REPO = "octo/widgets";
const KEY = "srk_parent";

async function setup(keyCap: number | null = 1) {
  const env = await buildTestEnv();
  const hash = await sha256Hex(KEY);
  await env.DB.prepare("INSERT INTO repos (repo, mode, prs_per_month, spend_cap_usd, created_at) VALUES (?, 'auto', 5, 5, ?)")
    .bind(REPO, NOW).run();
  await env.DB.prepare("INSERT INTO api_keys (hash, owner, repos_json, spend_cap_usd, created_at) VALUES (?, 'octo', ?, ?, ?)")
    .bind(hash, JSON.stringify([REPO]), keyCap, NOW).run();
  let calls = 0;
  const pending: Promise<unknown>[] = [];
  const deps: HandleAnthropicDeps & { jwksUrl: string } = {
    jwksUrl: "http://unused",
    anthropicBaseUrl: "https://anthropic.test",
    now: () => NOW,
    fetchUpstream: (async () => {
      calls++;
      return Response.json({ model: "claude-sonnet-4-6", usage: { input_tokens: 100, output_tokens: 40_000 } });
    }) as unknown as typeof fetch,
    waitUntil: (p) => pending.push(p),
  };
  const worker = {
    fetch: (request: Request, env: ReviewWorkerEnv) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/sessions") return handleSessions(request, env, deps, url.origin);
      if (url.pathname === "/api/plan") return handlePlan(request, env, url, NOW);
      return handleAnthropic(request, env, deps, url);
    },
  };
  const mint = () => worker.fetch(new Request("https://review.test/api/sessions", {
    method: "POST", body: JSON.stringify({ apiKey: KEY, repo: REPO, pr: 1 }),
  }), env);
  const session = async () => {
    const response = await mint();
    expect(response.status).toBe(200);
    return ((await response.json()) as { token: string }).token;
  };
  const proxy = (token: string, maxTokens = 1) => worker.fetch(new Request("https://review.test/anthropic/v1/messages", {
    method: "POST", headers: { "x-api-key": token },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: maxTokens, messages: [] }),
  }), env);
  const spend = (cost: number) => env.DB.prepare(
    "INSERT INTO usage_events (id, repo, pr, model, input_tokens, output_tokens, cost_usd, kind, created_at) VALUES ('prior', ?, 1, 'claude-sonnet-4-6', 0, 0, ?, 'messages', ?)",
  ).bind(REPO, cost, NOW).run();
  return { env, hash, worker, mint, session, proxy, spend, pending, calls: () => calls };
}

test("an exhausted direct key cannot mint a session or consume PR quota", async () => {
  const ctx = await setup();
  await ctx.spend(2);
  const direct = await ctx.proxy(KEY);
  expect(direct.status).toBe(402);
  const minted = await ctx.mint();
  expect(minted.status).toBe(402);
  expect(await minted.json()).toEqual(await direct.json());
  expect(await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>()).toEqual({ n: 0 });
  expect(await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM reviewed_prs").first<{ n: number }>()).toEqual({ n: 0 });
  expect(ctx.calls()).toBe(0);
});

test("mint persists the issuing key hash and caps the session at the remaining key budget", async () => {
  const ctx = await setup(3);
  await ctx.spend(2);
  await ctx.session();
  expect(await ctx.env.DB.prepare("SELECT api_key_hash, spend_cap_usd FROM sessions").first<{ api_key_hash: string | null; spend_cap_usd: number }>())
    .toEqual({ api_key_hash: ctx.hash, spend_cap_usd: 1 });
});

test.each(["revoked", "deleted", "unscoped"] as const)("a %s parent invalidates an existing session", async (change) => {
  const ctx = await setup();
  const token = await ctx.session();
  const sql = change === "revoked" ? "UPDATE api_keys SET revoked_at = 1 WHERE hash = ?"
    : change === "deleted" ? "DELETE FROM api_keys WHERE hash = ?"
    : "UPDATE api_keys SET repos_json = '[]' WHERE hash = ?";
  await ctx.env.DB.prepare(sql).bind(ctx.hash).run();
  expect((await ctx.proxy(token)).status).toBe(401);
  expect(ctx.calls()).toBe(0);
  expect((await ctx.mint()).status).toBe(change === "unscoped" ? 403 : 401);
});

test("an existing session inherits later parent cap reductions", async () => {
  const ctx = await setup(3);
  const token = await ctx.session();
  await ctx.spend(2);
  await ctx.env.DB.prepare("UPDATE api_keys SET spend_cap_usd = 1 WHERE hash = ?").bind(ctx.hash).run();
  const response = await ctx.proxy(token);
  expect(response.status).toBe(402);
  expect(await response.json()).toEqual({ error: "api key spend cap exhausted", repo: REPO, keyCapUsd: 1, spentUsd: 2 });
  expect(ctx.calls()).toBe(0);
});

test("direct calls and separately minted sessions share parent budget including reservations", async () => {
  const ctx = await setup();
  const tokens = [KEY, await ctx.session(), await ctx.session()];
  const responses = await Promise.all(tokens.map((token) => ctx.proxy(token, 40_000)));
  await Promise.all(responses.map((r) => r.text()));
  await Promise.all(ctx.pending);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 402, 402]);
  expect(ctx.calls()).toBe(1);
  const spend = await ctx.env.DB.prepare("SELECT SUM(cost_usd) AS spent FROM usage_events").first<{ spent: number }>();
  expect(spend!.spent).toBeGreaterThan(0);
  expect(spend!.spent).toBeLessThan(1);
  expect((await ctx.proxy(tokens[1], 40_000)).status).toBe(402);
});

test.each(["mint", "direct", "session", "plan"] as const)("%s returns the shared monthly-cap 402", async (handler) => {
  const ctx = await setup(null);
  const token = await ctx.session();
  await ctx.spend(25);
  const response = handler === "mint" ? await ctx.mint()
    : handler === "direct" ? await ctx.proxy(KEY)
    : handler === "session" ? await ctx.proxy(token)
    : await ctx.worker.fetch(new Request(`https://review.test/api/plan?repo=${REPO}`, {
      headers: { "x-api-key": KEY },
    }), ctx.env);
  expect(response.status).toBe(402);
  expect(await response.json()).toEqual({
    error: "repo monthly spend cap exhausted", repo: REPO,
    month: "2026-09", monthlyCapUsd: 25, spentUsd: 25,
  });
  expect(ctx.calls()).toBe(0);
});

test.each([null, 10])("a parent cap of %s preserves the repository session cap and meters successful calls", async (keyCap) => {
  const ctx = await setup(keyCap);
  const token = await ctx.session();
  expect(await ctx.env.DB.prepare("SELECT api_key_hash, spend_cap_usd FROM sessions").first<{ api_key_hash: string | null; spend_cap_usd: number }>())
    .toEqual({ api_key_hash: ctx.hash, spend_cap_usd: 5 });
  const response = await ctx.proxy(token, 40_000);
  expect(response.status).toBe(200);
  await response.text();
  await Promise.all(ctx.pending);
  const session = await ctx.env.DB.prepare("SELECT spent_usd FROM sessions").first<{ spent_usd: number }>();
  expect(session!.spent_usd).toBeCloseTo(0.6003, 6);
  const usage = await ctx.env.DB.prepare("SELECT repo, cost_usd FROM usage_events").first<{ repo: string; cost_usd: number }>();
  expect(usage!.repo).toBe(REPO);
  expect(usage!.cost_usd).toBe(session!.spent_usd);
});

test("removing repo registration cannot bypass an inherited key cap", async () => {
  const ctx = await setup();
  const token = await ctx.session();
  await ctx.env.DB.prepare("DELETE FROM repos WHERE repo = ?").bind(REPO).run();
  expect((await ctx.proxy(token)).status).toBe(403);
  expect(ctx.calls()).toBe(0);
});

test("case variants preserve key scope, session identity and the billing ledger", async () => {
  const ctx = await setup(3);
  await ctx.env.DB.prepare("UPDATE api_keys SET repos_json = ?").bind(JSON.stringify(["OCTO/WIDGETS"])).run();
  const token = await ctx.session();
  await ctx.spend(2);
  for (const credential of [KEY, token]) {
    const response = await ctx.worker.fetch(new Request("https://review.test/api/plan?repo=Octo/Widgets", {
      headers: { "x-api-key": credential },
    }), ctx.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ repo: REPO, quota: { monthlySpendUsd: 2 } });
  }
  const response = await ctx.worker.fetch(new Request("https://review.test/anthropic/v1/messages", {
    method: "POST", headers: { "x-api-key": KEY, "x-smithers-repo": "Octo/Widgets" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [] }),
  }), ctx.env);
  expect(response.status).toBe(200);
  await response.text();
  await Promise.all(ctx.pending);
  expect((await ctx.env.DB.prepare("SELECT DISTINCT repo FROM usage_events").all()).results).toEqual([{ repo: REPO }]);
});
