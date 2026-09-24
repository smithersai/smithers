import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createReviewWorker } from "../../src/server/worker.ts";
import type { ReviewWorkerEnv } from "../../src/server/env.ts";
import { sha256Hex } from "../../src/server/sha256Hex.ts";
import { fetchJwks } from "../../src/server/sessions/fetchJwks.ts";
import { jwksCache } from "../../src/server/sessions/jwksCache.ts";
import { lookupApiKey } from "../../src/server/sessions/lookupApiKey.ts";
import { verifyOidc } from "../../src/server/sessions/verifyOidc.ts";
import { parseUsageFromJson } from "../../src/server/proxy/parseUsageFromJson.ts";
import { teeForMetering } from "../../src/server/proxy/teeForMetering.ts";
import { buildTestEnv } from "./helpers/buildTestEnv.ts";
import { rsaKeypair } from "./helpers/rsaKeypair.ts";
import { serveJwks } from "./helpers/serveJwks.ts";
import { signTestJwt } from "./helpers/signTestJwt.ts";
import { serveFixtureAnthropic } from "./helpers/serveFixtureAnthropic.ts";

const SSE_USAGE = [
  "event: message_start",
  'data: {"type":"message_start","message":{"id":"m1","model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":1}}}',
  "",
  "event: message_delta",
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":10,"output_tokens":5}}',
  "",
  "event: message_stop",
  'data: {"type":"message_stop"}',
  "",
].join("\n");

const teardowns: (() => void)[] = [];
afterEach(() => {
  while (teardowns.length) teardowns.pop()!();
});

async function seedSession(env: ReviewWorkerEnv, repo: string, spendCapUsd = 1) {
  await env.DB.prepare("INSERT OR IGNORE INTO repos (repo, mode, prs_per_month, spend_cap_usd, created_at) VALUES (?, 'auto', 100, 100, 0)").bind(repo).run();
  const token = "srs_gaptoken";
  const hash = await sha256Hex(token);
  await env.DB.prepare(
    "INSERT INTO sessions (hash, repo, pr, expires_at, spend_cap_usd, spent_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(hash, repo, 1, Date.now() + 60_000, spendCapUsd, 0, Date.now())
    .run();
  return token;
}

function fixedWorker(overrides: Record<string, unknown>) {
  return createReviewWorker({
    jwksUrl: "http://unused",
    anthropicBaseUrl: "http://unused",
    fetchUpstream: fetch,
    now: () => Date.now(),
    waitUntil: () => undefined,
    ...overrides,
  });
}

describe("handleAdminKeys gaps", () => {
  test("401s without the admin token; 400s an invalid JSON body", async () => {
    const env = await buildTestEnv();
    const worker = fixedWorker({});
    const unauth = await worker.fetch(
      new Request("https://review.test/api/admin/keys", { method: "POST", body: "{}" }),
      env,
    );
    expect(unauth.status).toBe(401);

    const badJson = await worker.fetch(
      new Request("https://review.test/api/admin/keys", {
        method: "POST",
        headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
        body: "{not json",
      }),
      env,
    );
    expect(badJson.status).toBe(400);
    expect(((await badJson.json()) as { error: string }).error).toContain("invalid JSON");
  });

  test("400s when repos is not a string array", async () => {
    const env = await buildTestEnv();
    const worker = fixedWorker({});
    const res = await worker.fetch(
      new Request("https://review.test/api/admin/keys", {
        method: "POST",
        headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
        body: JSON.stringify({ owner: "octo", repos: "not-an-array" }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("repos must be a string array");
  });
});

describe("handleAdminRepos gaps", () => {
  test("400s an invalid JSON POST body and 405s an unsupported method", async () => {
    const env = await buildTestEnv();
    const worker = fixedWorker({});
    const badJson = await worker.fetch(
      new Request("https://review.test/api/admin/repos", {
        method: "POST",
        headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
        body: "{oops",
      }),
      env,
    );
    expect(badJson.status).toBe(400);

    const wrongMethod = await worker.fetch(
      new Request("https://review.test/api/admin/repos", {
        method: "PUT",
        headers: { authorization: "Bearer test-admin" },
      }),
      env,
    );
    expect(wrongMethod.status).toBe(405);
  });

  test("GET aggregates month-to-date usage and PR counts per repo", async () => {
    const env = await buildTestEnv();
    const worker = fixedWorker({});
    const now = Date.now();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO repos (repo, mode, prs_per_month, spend_cap_usd, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("octo/widgets", "auto", 5, 25, now)
      .run();
    await env.DB.prepare(
      "INSERT INTO usage_events (id, repo, pr, model, input_tokens, output_tokens, cost_usd, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("u1", "octo/widgets", 1, "claude-sonnet-4-6", 0, 0, 0.5, "messages", now)
      .run();
    const month = new Date(now).toISOString().slice(0, 7);
    await env.DB.prepare("INSERT INTO reviewed_prs (repo, pr, month, first_seen_at) VALUES (?, ?, ?, ?)")
      .bind("octo/widgets", 1, month, now)
      .run();

    const res = await worker.fetch(
      new Request("https://review.test/api/admin/repos", { headers: { authorization: "Bearer test-admin" } }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repos: Array<{ repo: string; usage: { spendUsd: number; prsThisMonth: number } }>;
    };
    expect(body.repos[0].usage.spendUsd).toBeCloseTo(0.5, 6);
    expect(body.repos[0].usage.prsThisMonth).toBe(1);
  });
});

describe("handleAnthropic gaps", () => {
  test("502s when the upstream fetch throws", async () => {
    const env = await buildTestEnv();
    const token = await seedSession(env, "octo/widgets");
    const worker = fixedWorker({
      anthropicBaseUrl: "https://anthropic.test",
      fetchUpstream: (async () => {
        throw new Error("connection refused");
      }) as unknown as typeof fetch,
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[]}',
      }),
      env,
    );
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("upstream fetch failed");
  });

  test("passes through a bodyless upstream response with retry-after and x-request-id", async () => {
    const env = await buildTestEnv();
    const token = await seedSession(env, "octo/widgets");
    const worker = fixedWorker({
      anthropicBaseUrl: "https://anthropic.test",
      fetchUpstream: (async () =>
        new Response(null, {
          status: 204,
          headers: { "retry-after": "5", "x-request-id": "req_9", "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[]}',
      }),
      env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(res.headers.get("x-request-id")).toBe("req_9");
  });

  test("logs 'metering failed' when the usage write throws", async () => {
    const env = await buildTestEnv();
    const token = await seedSession(env, "octo/widgets");
    const fixture = serveFixtureAnthropic({ contentType: "text/event-stream", body: SSE_USAGE });
    teardowns.push(() => fixture.stop());
    // Admission must work; inject failure only at the event INSERT.
    await env.DB.exec(
      "CREATE TRIGGER fail_usage BEFORE INSERT ON usage_events BEGIN SELECT RAISE(ABORT, 'injected event failure'); END",
    );
    const meterings: Promise<unknown>[] = [];
    const worker = fixedWorker({
      anthropicBaseUrl: fixture.baseUrl,
      waitUntil: (p: Promise<unknown>) => meterings.push(p),
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await worker.fetch(
        new Request("https://review.test/anthropic/v1/messages", {
          method: "POST",
          headers: { "x-api-key": token, "content-type": "application/json" },
          body: '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[]}',
        }),
        env,
      );
      expect(res.status).toBe(200);
      await res.text();
      await Promise.all(meterings);
      expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("metering failed"))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("handleSessions gaps", () => {
  test("400s an invalid JSON body", async () => {
    const env = await buildTestEnv();
    const worker = fixedWorker({});
    const res = await worker.fetch(
      new Request("https://review.test/api/sessions", { method: "POST", body: "{nope" }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("invalid JSON");
  });

  test("400s a body carrying neither an oidcToken nor an apiKey", async () => {
    const env = await buildTestEnv();
    const worker = fixedWorker({});
    const res = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: "octo/widgets", pr: 1 }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("expected oidcToken or apiKey");
  });

  test("api-key path: missing repo, missing pr, and repo-not-authorized", async () => {
    const env = await buildTestEnv();
    const worker = fixedWorker({});
    const apiKey = "srk_sessionscope";
    await env.DB.prepare("INSERT INTO api_keys (hash, owner, repos_json, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(apiKey), "octo", JSON.stringify(["octo/widgets"]), Date.now())
      .run();

    const missingRepo = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey, pr: 1 }),
      }),
      env,
    );
    expect(missingRepo.status).toBe(400);
    expect(((await missingRepo.json()) as { error: string }).error).toContain("missing repo");

    const missingPr = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey, repo: "octo/widgets" }),
      }),
      env,
    );
    expect(missingPr.status).toBe(400);
    expect(((await missingPr.json()) as { error: string }).error).toContain("pull request number");

    const notAuthorized = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey, repo: "someone/else", pr: 2 }),
      }),
      env,
    );
    expect(notAuthorized.status).toBe(403);
    expect(((await notAuthorized.json()) as { error: string }).error).toContain("not authorized for repo");
  });

  test("oidc path: 401s a token that carries no repository claim", async () => {
    const env = await buildTestEnv();
    const keypair = await rsaKeypair("kid-norepo");
    const jwks = serveJwks([keypair.publicJwk]);
    teardowns.push(() => jwks.stop());
    const worker = fixedWorker({ jwksUrl: jwks.url });
    const token = await signTestJwt(keypair, {
      iss: "https://token.actions.githubusercontent.com",
      aud: "smithers-review",
      exp: Math.floor(Date.now() / 1000) + 600,
      repository: "",
    });
    const res = await worker.fetch(
      new Request("https://review.test/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oidcToken: token }),
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toContain("missing repository claim");
  });
});

describe("handleWalkthroughs gaps", () => {
  test("401s when neither the legacy token nor a session/api-key credential is valid", async () => {
    const env = await buildTestEnv();
    const worker = fixedWorker({});
    const res = await worker.fetch(
      new Request("https://review.test/api/walkthroughs", {
        method: "POST",
        headers: { authorization: "Bearer wrong-token", "content-type": "text/html" },
        body: "<html></html>",
      }),
      env,
    );
    expect(res.status).toBe(401);
  });
});

describe("verifyOidc malformed base64url", () => {
  test("returns malformed when a segment is not valid base64url JSON", async () => {
    // Header/payload decode to non-JSON bytes → base64UrlToJson returns null.
    const outcome = await verifyOidc("!!!.@@@.sig", "http://unused", Date.now());
    expect(outcome).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("fetchJwks", () => {
  beforeEach(() => jwksCache.clear());

  test("serves from cache on the second call, throws on non-200, and tolerates a keyless body", async () => {
    const keypair = await rsaKeypair("k");
    let calls = 0;
    const okImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ keys: [keypair.publicJwk] }), { status: 200 });
    }) as unknown as typeof fetch;
    const now = Date.now();
    const first = await fetchJwks("https://jwks.test/a", now, okImpl);
    const second = await fetchJwks("https://jwks.test/a", now, okImpl);
    expect(first).toEqual(second);
    expect(calls).toBe(1); // second call hit the cache

    const failImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(fetchJwks("https://jwks.test/b", now, failImpl)).rejects.toThrow("returned 500");

    const keylessImpl = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchJwks("https://jwks.test/c", now, keylessImpl)).toEqual([]);
  });
});

describe("lookupApiKey", () => {
  test("returns null for unknown keys and defaults malformed/non-string repos to []", async () => {
    const env = await buildTestEnv();
    expect(await lookupApiKey(env.DB, "srk_missing")).toBeNull();

    const badKey = "srk_badrepos";
    await env.DB.prepare("INSERT INTO api_keys (hash, owner, repos_json, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(badKey), "octo", "not json", Date.now())
      .run();
    const bad = await lookupApiKey(env.DB, badKey);
    expect(bad?.repos).toEqual([]);

    const mixedKey = "srk_mixedrepos";
    await env.DB.prepare("INSERT INTO api_keys (hash, owner, repos_json, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(mixedKey), "octo", JSON.stringify(["a/b", 42, "c/d"]), Date.now())
      .run();
    const mixed = await lookupApiKey(env.DB, mixedKey);
    expect(mixed?.repos).toEqual(["a/b", "c/d"]);
  });
});

describe("usage parsers", () => {
  test("parseUsageFromJson returns null on invalid JSON", () => {
    expect(parseUsageFromJson("{not json")).toBeNull();
  });

  test("streaming metering refuses malformed usage frames", async () => {
    const stream = [
      "event: message_delta",
      "data: {broken json",
      "",
      "event: ping", // an event with no data line at all
      "",
      "event: message_start",
      'data: {"type":"message_start","message":{"id":"m","model":"claude-x","usage":{"input_tokens":3,"output_tokens":1}}}',
      "",
    ].join("\n");
    const { passthrough, collected } = teeForMetering(new Response(stream), true, new AbortController());
    await new Response(passthrough).text();
    expect(await collected).toEqual({ summary: null, complete: false });
  });
});

describe("worker default waitUntil branches", () => {
  test("uses ctx.waitUntil when provided, and the standalone fallback when absent", async () => {
    const fixture = serveFixtureAnthropic({ contentType: "text/event-stream", body: SSE_USAGE });
    teardowns.push(() => fixture.stop());

    // No waitUntil override → defaultDeps(ctx).waitUntil is exercised.
    const withCtx = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
    });

    const envA = await buildTestEnv();
    const tokenA = await seedSession(envA, "octo/widgets");
    const captured: Promise<unknown>[] = [];
    const resA = await withCtx.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": tokenA, "content-type": "application/json" },
        body: '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[]}',
      }),
      envA,
      { waitUntil: (p: Promise<unknown>) => captured.push(p) },
    );
    expect(resA.status).toBe(200);
    await resA.text();
    expect(captured.length).toBe(1);
    await Promise.all(captured);

    // No ctx at all → the standalone fallback arrow (p.catch(...)) runs.
    const envB = await buildTestEnv();
    const tokenB = await seedSession(envB, "octo/widgets");
    const resB = await withCtx.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": tokenB, "content-type": "application/json" },
        body: '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[]}',
      }),
      envB,
    );
    expect(resB.status).toBe(200);
    await resB.text();
    // Give the detached metering promise a tick to settle against the in-memory DB.
    await new Promise((r) => setTimeout(r, 50));
  });
});
