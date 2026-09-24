import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { handleAnthropic } from "../../src/server/proxy/handleAnthropic.ts";
import { sha256Hex } from "../../src/server/sha256Hex.ts";
import { createReviewWorker } from "../../src/server/worker.ts";
import type { ReviewWorkerEnv } from "../../src/server/env.ts";
import { buildTestEnv } from "./helpers/buildTestEnv.ts";
import { serveFixtureAnthropic } from "./helpers/serveFixtureAnthropic.ts";

const REPO = "octo/widgets";

const SSE_USAGE = [
  "event: message_start",
  'data: {"type":"message_start","message":{"id":"m1","model":"claude-sonnet-4-6","usage":{"input_tokens":300,"output_tokens":1}}}',
  "",
  "event: content_block_delta",
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}',
  "",
  "event: message_delta",
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":300,"output_tokens":42}}',
  "",
  "event: message_stop",
  'data: {"type":"message_stop"}',
  "",
].join("\n");

const SINGLE_CALL_COST_USD = 0.00153;
let usageId = 0;

const SSE_USAGE_WITH_CACHE = [
  "event: message_start",
  'data: {"type":"message_start","message":{"id":"m2","model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":1,"cache_creation_input_tokens":200,"cache_read_input_tokens":4000}}}',
  "",
  "event: message_delta",
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":10,"output_tokens":42}}',
  "",
  "event: message_stop",
  'data: {"type":"message_stop"}',
  "",
].join("\n");

function sseUsageWithLargeBodyBeforeFinalUsage(): string {
  return [
    "event: message_start",
    'data: {"type":"message_start","message":{"id":"m1","model":"claude-sonnet-4-6","usage":{"input_tokens":300,"output_tokens":1}}}',
    "",
    "event: content_block_delta",
    `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"${"x".repeat((1 << 20) + 1024)}"}}`,
    "",
    "event: message_delta",
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":300,"output_tokens":42}}',
    "",
    "event: message_stop",
    'data: {"type":"message_stop"}',
    "",
  ].join("\n");
}

async function seedSession(env: ReviewWorkerEnv, repo: string, spendCapUsd = 1) {
  await env.DB.prepare("INSERT OR IGNORE INTO repos (repo, mode, prs_per_month, spend_cap_usd, created_at) VALUES (?, 'auto', 100, 100, 0)").bind(repo).run();
  const token = "srs_testsessiontoken";
  const hash = await sha256Hex(token);
  await env.DB.prepare(
    "INSERT INTO sessions (hash, repo, pr, expires_at, spend_cap_usd, spent_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(hash, repo, 99, Date.now() + 60_000, spendCapUsd, 0, Date.now())
    .run();
  return token;
}

async function registerRepo(env: ReviewWorkerEnv, repo: string, prsPerMonth = 5, spendCapUsd = 1) {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO repos (repo, mode, prs_per_month, spend_cap_usd, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(repo, "auto", prsPerMonth, spendCapUsd, Date.now())
    .run();
}

async function seedUsage(env: ReviewWorkerEnv, repo: string, costUsd: number) {
  await env.DB.prepare(
    "INSERT INTO usage_events (id, repo, pr, model, input_tokens, output_tokens, cost_usd, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(`usage-${usageId++}`, repo, 1, "claude-sonnet-4-6", 0, 0, costUsd, "messages", Date.now())
    .run();
}

const teardowns: (() => void)[] = [];
afterEach(() => {
  while (teardowns.length) teardowns.pop()!();
});

function makeWorker(anthropicBaseUrl: string) {
  return {
    pendingMeter: [] as Promise<unknown>[],
    worker: createReviewWorker({
      jwksUrl: "http://unused",
      fetchUpstream: fetch,
      now: () => Date.now(),
      anthropicBaseUrl,
      waitUntil: () => undefined,
    }),
  };
}

describe("anthropic proxy", () => {
  test("rejects requests outside /v1/", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: "{}" });
    teardowns.push(() => fixture.stop());
    const harness = makeWorker(fixture.baseUrl);
    const meterings: Promise<unknown>[] = [];
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: (p) => meterings.push(p),
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v2/messages", { method: "POST", body: "{}" }),
      env,
    );
    expect(res.status).toBe(404);
    // unused
    void harness;
  });

  test("refuses file, batch and non-POST endpoints without ever calling upstream", async () => {
    // The forwarded request carries the service-wide key, and Anthropic's file
    // and batch APIs are workspace-scoped: a repo-scoped caller reaching them
    // would read, delete and asynchronously spend against every other tenant's
    // objects in the shared account. Authenticate the caller first so the 404
    // proves the endpoint allowlist, not a rejected credential.
    const env = await buildTestEnv();
    await registerRepo(env, REPO);
    const token = await seedSession(env, REPO);
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: "{}" });
    teardowns.push(() => fixture.stop());
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: () => undefined,
    });
    const refused: [string, string][] = [
      ["GET", "/v1/files"],
      ["DELETE", "/v1/files/foreign-tenant-file"],
      ["POST", "/v1/messages/batches"],
      ["GET", "/v1/messages/batches/msgbatch_foreign"],
      ["GET", "/v1/messages"],
      ["POST", "/v1/messages/"],
    ];
    for (const [method, path] of refused) {
      const res = await worker.fetch(
        new Request(`https://review.test/anthropic${path}`, {
          method,
          headers: { "x-api-key": token, "content-type": "application/json" },
          ...(method === "GET" || method === "HEAD" ? {} : { body: "{}" }),
        }),
        env,
      );
      expect([method, path, res.status]).toEqual([method, path, 404]);
      await res.text();
    }
    // Nothing reached the fixture, so the real key was never attached to any
    // of these requests.
    expect(fixture.requests).toEqual([]);
    const usage = await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_events").first<{ n: number }>();
    expect(usage?.n).toBe(0);
  });

  test("401s unknown sessions", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: "{}" });
    teardowns.push(() => fixture.stop());
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: () => undefined,
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "unknown" },
        body: '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[]}',
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  test("forwards to api.anthropic.com with the real key and meters SSE usage", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "text/event-stream", body: SSE_USAGE });
    teardowns.push(() => fixture.stop());
    const token = await seedSession(env, REPO);
    const meterings: Promise<unknown>[] = [];
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: (p) => meterings.push(p),
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[]}',
      }),
      env,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("message_start");
    expect(fixture.requests.length).toBe(1);
    expect(fixture.requests[0].headers["x-api-key"]).toBe("sk-ant-test");
    expect(fixture.requests[0].headers["x-api-key"]).not.toBe(token);
    await Promise.all(meterings);
    const usage = await env.DB.prepare("SELECT * FROM usage_events").all();
    expect(usage.results.length).toBe(1);
    const row = usage.results[0] as Record<string, unknown>;
    expect(row.repo).toBe(REPO);
    expect(row.model).toBe("claude-sonnet-4-6");
    expect(row.input_tokens).toBe(300);
    expect(row.output_tokens).toBe(42);
    expect(row.kind).toBe("messages_stream");
    // 300 * 3/1e6 + 42 * 15/1e6 = 0.0009 + 0.00063 = 0.00153
    expect(row.cost_usd as number).toBeCloseTo(SINGLE_CALL_COST_USD, 6);
    const session = await env.DB.prepare("SELECT spent_usd FROM sessions").first<{ spent_usd: number }>();
    expect(session?.spent_usd ?? 0).toBeCloseTo(SINGLE_CALL_COST_USD, 6);
  });

  test("persists cache token counts so cache-heavy spend can be explained and backfilled", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "text/event-stream", body: SSE_USAGE_WITH_CACHE });
    teardowns.push(() => fixture.stop());
    const token = await seedSession(env, REPO);
    const meterings: Promise<unknown>[] = [];
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: (p) => meterings.push(p),
    });
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
    const row = await env.DB.prepare("SELECT * FROM usage_events").first<Record<string, unknown>>();
    expect(row?.input_tokens).toBe(10);
    expect(row?.output_tokens).toBe(42);
    expect(row?.cache_creation_tokens).toBe(200);
    expect(row?.cache_read_tokens).toBe(4000);
    // Cost folds cache tokens in: 10*3 + 42*15 + 200*3.75 + 4000*0.3 = per-1e6 USD.
    const expected = (10 * 3 + 42 * 15 + 200 * 3.75 + 4000 * 0.3) / 1_000_000;
    expect(row?.cost_usd as number).toBeCloseTo(expected, 9);
  });

  test("meters SSE usage after more than 1 MiB of streamed content", async () => {
    const env = await buildTestEnv();
    const token = await seedSession(env, REPO);
    const meterings: Promise<unknown>[] = [];
    const encoder = new TextEncoder();
    const bodyParts = sseUsageWithLargeBodyBeforeFinalUsage().split("\n\nevent: message_delta");
    const fetchUpstream = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(bodyParts[0]));
            controller.enqueue(encoder.encode(`\n\nevent: message_delta${bodyParts[1]}`));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )) as unknown as typeof fetch;
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: "https://anthropic.test",
      fetchUpstream,
      now: () => Date.now(),
      waitUntil: (p) => meterings.push(p),
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[]}',
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(sseUsageWithLargeBodyBeforeFinalUsage());
    await Promise.all(meterings);

    const row = await env.DB.prepare("SELECT * FROM usage_events").first<Record<string, unknown>>();
    expect(row?.input_tokens).toBe(300);
    expect(row?.output_tokens).toBe(42);
    expect(row?.cost_usd as number).toBeCloseTo(SINGLE_CALL_COST_USD, 6);
  });

  test("logs a metering miss when a 2xx messages response yields no usage (silent unmetered spend)", async () => {
    const env = await buildTestEnv();
    // A 200 /v1/messages body with no `model`: parseUsageFromJson returns null,
    // so real spend would go unrecorded. That must be surfaced, not swallowed.
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: '{"id":"x","content":[]}' });
    teardowns.push(() => fixture.stop());
    const token = await seedSession(env, REPO);
    const meterings: Promise<unknown>[] = [];
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: (p) => meterings.push(p),
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
      const logged = errorSpy.mock.calls.some((call) => String(call[0]).includes("metering miss"));
      expect(logged).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
    const usage = await env.DB.prepare("SELECT * FROM usage_events").all();
    expect(usage.results.length).toBe(0);
  });

  test("records every admitted call when a cap is lowered while calls are in flight", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "text/event-stream", body: SSE_USAGE });
    teardowns.push(() => fixture.stop());
    const token = await seedSession(env, REPO, 1);
    const meterings: Promise<unknown>[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: (async () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              await held;
              controller.enqueue(new TextEncoder().encode(SSE_USAGE));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )) as unknown as typeof fetch,
      now: () => Date.now(),
      waitUntil: (p) => meterings.push(p),
    });
    const makeRequest = () =>
      worker.fetch(
        new Request("https://review.test/anthropic/v1/messages", {
          method: "POST",
          headers: { "x-api-key": token, "content-type": "application/json" },
          body: '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[]}',
        }),
        env,
      );

    const [first, second] = await Promise.all([makeRequest(), makeRequest()]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await env.DB.prepare("UPDATE sessions SET spend_cap_usd = ?")
      .bind(SINGLE_CALL_COST_USD + 0.00001)
      .run();
    release();
    await Promise.all([first.text(), second.text()]);
    await Promise.all(meterings);

    // Both calls were forwarded and billed at Anthropic, so both must land in the
    // audit ledger and the spend tally. Lowering a cap cannot
    // un-spend an already-streamed one. Previously the over-cap call was silently
    // dropped from both usage_events and spent_usd, undercounting real spend.
    const usage = await env.DB.prepare("SELECT cost_usd FROM usage_events").all<{ cost_usd: number }>();
    expect(usage.results.length).toBe(2);
    const session = await env.DB.prepare("SELECT spent_usd FROM sessions").first<{ spent_usd: number }>();
    expect(session?.spent_usd ?? 0).toBeCloseTo(2 * SINGLE_CALL_COST_USD, 6);
  });

  test("oversized JSON forwards unchanged and retains its unmetered hold", async () => {
    const env = await buildTestEnv();
    const token = await seedSession(env, REPO);
    const body = JSON.stringify({
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "x".repeat(1024 * 1024 + 1) }],
      usage: { input_tokens: 300, output_tokens: 42 },
    });
    const pending: Promise<unknown>[] = [];
    const worker = createReviewWorker({
      jwksUrl: "unused",
      anthropicBaseUrl: "https://anthropic.test",
      now: Date.now,
      waitUntil: (p) => pending.push(p),
      fetchUpstream: (async () =>
        new Response(body, { headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    });
    const response = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1024, messages: [] }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
    await Promise.all(pending);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_events").first<{ n: number }>())?.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_reservations").first<{ n: number }>())?.n).toBe(1);
  });

  test("meters non-streaming JSON response and records kind=messages", async () => {
    const env = await buildTestEnv();
    const JSON_BODY = JSON.stringify({
      id: "msg_01",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 150, output_tokens: 30 },
    });
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: JSON_BODY });
    teardowns.push(() => fixture.stop());
    const token = await seedSession(env, REPO);
    const meterings: Promise<unknown>[] = [];
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: (p) => meterings.push(p),
    });
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
    const row = await env.DB.prepare("SELECT * FROM usage_events").first<Record<string, unknown>>();
    expect(row?.kind).toBe("messages");
    expect(row?.model).toBe("claude-sonnet-4-6");
    expect(row?.input_tokens).toBe(150);
    expect(row?.output_tokens).toBe(30);
    // 150 * 3/1e6 + 30 * 15/1e6 = 0.00045 + 0.00045 = 0.0009
    expect(row?.cost_usd as number).toBeCloseTo(0.0009, 6);
  });

  test("authenticates srk_ api-key and proxies request with usage attributed to repo", async () => {
    const env = await buildTestEnv();
    const JSON_BODY = JSON.stringify({
      id: "msg_02",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "world" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: JSON_BODY });
    teardowns.push(() => fixture.stop());
    await registerRepo(env, "octo/widgets");
    const apiKey = "srk_testoperatorkey";
    const keyHash = await sha256Hex(apiKey);
    await env.DB.prepare("INSERT INTO api_keys (hash, owner, repos_json, created_at) VALUES (?, ?, ?, ?)")
      .bind(keyHash, "octo", JSON.stringify(["octo/widgets"]), Date.now())
      .run();
    const meterings: Promise<unknown>[] = [];
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: (p) => meterings.push(p),
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "content-type": "application/json" },
        body: '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[]}',
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(fixture.requests[0].headers["x-api-key"]).toBe("sk-ant-test");
    expect(fixture.requests[0].headers["x-api-key"]).not.toBe(apiKey);
    await res.text();
    await Promise.all(meterings);
    const row = await env.DB.prepare("SELECT * FROM usage_events").first<Record<string, unknown>>();
    expect(row?.repo).toBe("octo/widgets");
    expect(row?.kind).toBe("messages");
    expect(row?.input_tokens).toBe(100);
    expect(row?.output_tokens).toBe(20);
  });

  test("401s srk_ key not in api_keys table", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: "{}" });
    teardowns.push(() => fixture.stop());
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: () => undefined,
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "srk_unknownkey" },
        body: '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[]}',
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  test("402s when session spend cap is already at or above limit", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: "{}" });
    teardowns.push(() => fixture.stop());
    const token = await seedSession(env, REPO, 0.001);
    // Bump spent above cap.
    const hash = await sha256Hex(token);
    await env.DB.prepare("UPDATE sessions SET spent_usd = ? WHERE hash = ?").bind(0.005, hash).run();
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: () => undefined,
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[]}',
      }),
      env,
    );
    expect(res.status).toBe(402);
  });

  test("attributes srk_ spend to the repo named in x-smithers-repo", async () => {
    const env = await buildTestEnv();
    const JSON_BODY = JSON.stringify({
      id: "msg_03",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: JSON_BODY });
    teardowns.push(() => fixture.stop());
    await registerRepo(env, "octo/widgets");
    await registerRepo(env, "octo/wrenches");
    const apiKey = "srk_multirepo";
    await env.DB.prepare("INSERT INTO api_keys (hash, owner, repos_json, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(apiKey), "octo", JSON.stringify(["octo/widgets", "octo/wrenches"]), Date.now())
      .run();
    const meterings: Promise<unknown>[] = [];
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: (p) => meterings.push(p),
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "x-smithers-repo": "octo/wrenches",
          "content-type": "application/json",
        },
        body: '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[]}',
      }),
      env,
    );
    expect(res.status).toBe(200);
    await res.text();
    await Promise.all(meterings);
    const row = await env.DB.prepare("SELECT repo FROM usage_events").first<{ repo: string }>();
    expect(row?.repo).toBe("octo/wrenches");
  });

  test("403s an x-smithers-repo hint outside the srk_ key's repo list", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: "{}" });
    teardowns.push(() => fixture.stop());
    const apiKey = "srk_limitedkey";
    await env.DB.prepare("INSERT INTO api_keys (hash, owner, repos_json, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(apiKey), "octo", JSON.stringify(["octo/widgets"]), Date.now())
      .run();
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: () => undefined,
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "x-smithers-repo": "evil/other",
          "content-type": "application/json",
        },
        body: '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[]}',
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(fixture.requests.length).toBe(0);
  });

  test("403s srk_ proxy requests for unregistered repos", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: "{}" });
    teardowns.push(() => fixture.stop());
    const apiKey = "srk_unregistered";
    await env.DB.prepare("INSERT INTO api_keys (hash, owner, repos_json, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(apiKey), "octo", JSON.stringify(["octo/missing"]), Date.now())
      .run();
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: () => undefined,
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "content-type": "application/json" },
        body: '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[]}',
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("repo not registered");
    expect(fixture.requests.length).toBe(0);
  });

  test("402s srk_ proxy requests once the repo monthly spend cap is reached", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: "{}" });
    teardowns.push(() => fixture.stop());
    await registerRepo(env, REPO, 1, 0.01);
    await seedUsage(env, REPO, 0.02);
    const apiKey = "srk_spentrepo";
    await env.DB.prepare("INSERT INTO api_keys (hash, owner, repos_json, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(apiKey), "octo", JSON.stringify([REPO]), Date.now())
      .run();
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: () => undefined,
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "content-type": "application/json" },
        body: '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[]}',
      }),
      env,
    );
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toContain("monthly spend cap");
    expect(fixture.requests.length).toBe(0);
  });

  test("402s an srk_ key once its own per-key spend cap is reached (below the repo monthly cap)", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: "{}" });
    teardowns.push(() => fixture.stop());
    await registerRepo(env, REPO, 100, 1);
    await seedUsage(env, REPO, 0.02);
    const apiKey = "srk_spentkey";
    await env.DB.prepare(
      "INSERT INTO api_keys (hash, owner, repos_json, spend_cap_usd, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(await sha256Hex(apiKey), "octo", JSON.stringify([REPO]), 0.01, Date.now())
      .run();
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: () => undefined,
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "content-type": "application/json" },
        body: '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[]}',
      }),
      env,
    );
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toContain("api key spend cap");
    expect(fixture.requests.length).toBe(0);
  });

  test("402s a re-minted session once the repo's monthly spend cap is reached", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "text/event-stream", body: SSE_USAGE });
    teardowns.push(() => fixture.stop());
    // Plan ceiling = prs_per_month * spend_cap_usd = 1 * 0.01 = 0.01.
    await env.DB.prepare(
      "INSERT OR REPLACE INTO repos (repo, mode, prs_per_month, spend_cap_usd, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(REPO, "auto", 1, 0.01, Date.now())
      .run();
    // Month-to-date spend already crossed the ceiling.
    await env.DB.prepare(
      "INSERT INTO usage_events (id, repo, pr, model, input_tokens, output_tokens, cost_usd, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("u1", REPO, 1, "claude-sonnet-4-6", 0, 0, 0.02, "messages", Date.now())
      .run();
    // A fresh session: spent_usd = 0 with a high per-session cap, i.e. a re-mint
    // that reset the per-session budget. The per-repo ceiling must still bite.
    const token = await seedSession(env, REPO, 1);
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: () => undefined,
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[]}',
      }),
      env,
    );
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toContain("monthly spend cap");
    // Enforced pre-flight: no real Anthropic call was made.
    expect(fixture.requests.length).toBe(0);
  });

  test("forwards for a registered repo still under its monthly spend cap", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "text/event-stream", body: SSE_USAGE });
    teardowns.push(() => fixture.stop());
    // Ceiling = 5 * 1 = 5; nothing spent yet.
    await env.DB.prepare(
      "INSERT OR REPLACE INTO repos (repo, mode, prs_per_month, spend_cap_usd, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(REPO, "auto", 5, 1, Date.now())
      .run();
    const token = await seedSession(env, REPO, 1);
    const meterings: Promise<unknown>[] = [];
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: (p) => meterings.push(p),
    });
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
    expect(fixture.requests.length).toBe(1);
  });

  test("forwards retry-after and x-request-id from upstream responses", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({
      status: 429,
      contentType: "application/json",
      body: '{"type":"error","error":{"type":"rate_limit_error"}}',
      headers: { "retry-after": "17", "x-request-id": "req_abc123" },
    });
    teardowns.push(() => fixture.stop());
    const token = await seedSession(env, REPO);
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: () => undefined,
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token, "content-type": "application/json" },
        body: '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[]}',
      }),
      env,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("17");
    expect(res.headers.get("x-request-id")).toBe("req_abc123");
  });

  test("403s an x-smithers-repo hint from a key scoped to NO repos (no cross-tenant spend)", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: "{}" });
    teardowns.push(() => fixture.stop());
    // A registered victim repo the attacker would love to bill against.
    await registerRepo(env, "victim/repo");
    const apiKey = "srk_noreposkey";
    // repos_json = [] — an unscoped key. Previously the hint check was
    // `auth.repos.length > 0 && !includes(hint)`, which is vacuously false for
    // an empty list, so the hint was accepted and the key could meter spend
    // against ANY repo. Must 403 before any upstream call.
    await env.DB.prepare("INSERT INTO api_keys (hash, owner, repos_json, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(apiKey), "octo", JSON.stringify([]), Date.now())
      .run();
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: () => undefined,
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "x-smithers-repo": "victim/repo",
          "content-type": "application/json",
        },
        body: '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[]}',
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("not scoped to any repo");
    expect(fixture.requests.length).toBe(0);
  });

  test("403s a no-repos key with no hint with an actionable message (not 'repo not registered')", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: "{}" });
    teardowns.push(() => fixture.stop());
    const apiKey = "srk_noreposnohint";
    await env.DB.prepare("INSERT INTO api_keys (hash, owner, repos_json, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(apiKey), "octo", JSON.stringify([]), Date.now())
      .run();
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: () => undefined,
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "content-type": "application/json" },
        body: '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[]}',
      }),
      env,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    // The old code fell back to auth.owner ("octo") and 403'd on the misleading
    // "repo not registered"; now the message points at the real fix (mint a
    // repo-scoped key).
    expect(body.error).toContain("not scoped to any repo");
    expect(body.error).not.toContain("repo not registered");
    expect(fixture.requests.length).toBe(0);
  });

  test("402s at exactly spend == cap (>= boundary) and names repo + month", async () => {
    const env = await buildTestEnv();
    const fixture = serveFixtureAnthropic({ contentType: "application/json", body: "{}" });
    teardowns.push(() => fixture.stop());
    // Ceiling = prs_per_month * spend_cap_usd = 1 * 0.01 = 0.01; spend exactly 0.01.
    await registerRepo(env, REPO, 1, 0.01);
    await seedUsage(env, REPO, 0.01);
    const apiKey = "srk_boundarykey";
    await env.DB.prepare("INSERT INTO api_keys (hash, owner, repos_json, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(apiKey), "octo", JSON.stringify([REPO]), Date.now())
      .run();
    const worker = createReviewWorker({
      jwksUrl: "http://unused",
      anthropicBaseUrl: fixture.baseUrl,
      fetchUpstream: fetch,
      now: () => Date.now(),
      waitUntil: () => undefined,
    });
    const res = await worker.fetch(
      new Request("https://review.test/anthropic/v1/messages", {
        method: "POST",
        headers: { "x-api-key": apiKey, "content-type": "application/json" },
        body: '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[]}',
      }),
      env,
    );
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string; repo: string; month: string };
    expect(body.error).toContain("monthly spend cap");
    expect(body.repo).toBe(REPO);
    expect(body.month).toMatch(/^\d{4}-\d{2}$/);
    expect(fixture.requests.length).toBe(0);
  });
});

describe("proxy stream lifecycle", () => {
  async function streamingResponse(body: ReadableStream<Uint8Array>, signal?: AbortSignal, streamTimeoutMs?: number) {
    const env = await buildTestEnv();
    const token = await seedSession(env, REPO);
    const pending: Promise<unknown>[] = [];
    const signals: (AbortSignal | null | undefined)[] = [];
    const request = new Request("https://review.test/anthropic/v1/messages", {
      method: "POST",
      headers: { "x-api-key": token },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1024, messages: [] }),
      signal,
    });
    const response = await handleAnthropic(
      request,
      env,
      {
        anthropicBaseUrl: "https://anthropic.test",
        now: Date.now,
        streamTimeoutMs,
        waitUntil: (p) => pending.push(p),
        fetchUpstream: (async (_url, init) => {
          signals.push(init?.signal);
          return new Response(body, { headers: { "content-type": "text/event-stream" } });
        }) as typeof fetch,
      },
      new URL(request.url),
    );
    expect(response.status).toBe(200);
    return { env, pending, signals, response };
  }

  const start =
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":300,"output_tokens":1}}}\n\n';
  const delta = 'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n';
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

  test("client cancellation cancels upstream and records only observed usage", async () => {
    let cancelled = 0;
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
      },
      cancel() {
        cancelled++;
      },
    });
    const { response, env, pending, signals } = await streamingResponse(body);
    const reader = response.body!.getReader();
    source.enqueue(new TextEncoder().encode(start + delta));
    await reader.read();
    // This usage frame is incomplete and must not be included on cancellation.
    source.enqueue(
      new TextEncoder().encode('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":999}}'),
    );
    await reader.read();
    const cancellation = reader.cancel("client gone");
    await tick();
    const observedCancellation = cancelled;
    // Ensure the broken tee can finish too, so the failing test leaves no work behind.
    if (!cancelled) source.close();
    await cancellation;
    await Promise.all(pending);
    expect(observedCancellation).toBe(1);
    expect(signals[0]?.aborted).toBe(true);
    const usage = await env.DB.prepare("SELECT * FROM usage_events").first<Record<string, unknown>>();
    expect(usage?.input_tokens).toBe(300);
    expect(usage?.output_tokens).toBe(7);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_reservations").first<{ n: number }>())?.n).toBe(1);
  });

  test("a slow client bounds upstream read-ahead", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new TextEncoder().encode(pulls === 1 ? start : delta));
        if (pulls === 100) controller.close();
      },
    });
    const { response, pending } = await streamingResponse(body);
    await tick();
    const beforeRead = pulls;
    const reader = response.body!.getReader();
    await reader.read();
    await tick();
    const afterRead = pulls;
    await reader.cancel();
    await Promise.all(pending);
    expect(beforeRead).toBeLessThanOrEqual(3);
    expect(afterRead).toBeLessThanOrEqual(beforeRead + 1);
  });

  test("stream deadline cancels a stalled response and persists observed usage", async () => {
    let cancelled = 0;
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
      },
      cancel() {
        cancelled++;
      },
    });
    const { response, pending, signals, env } = await streamingResponse(body, undefined, 40);
    const reader = response.body!.getReader();
    source.enqueue(new TextEncoder().encode(start + delta));
    await reader.read();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const observedCancellation = cancelled;
    if (!cancelled) source.close();
    await reader.read().catch(() => undefined);
    await Promise.all(pending);
    expect(observedCancellation).toBe(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(
      (await env.DB.prepare("SELECT output_tokens FROM usage_events").first<{ output_tokens: number }>())
        ?.output_tokens,
    ).toBe(7);
  });

  test("upstream failure persists usage already forwarded", async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
      },
    });
    const { response, pending, signals, env } = await streamingResponse(body);
    const reader = response.body!.getReader();
    source.enqueue(new TextEncoder().encode(start + delta));
    await reader.read();
    source.error(new Error("upstream disconnected"));
    await expect(reader.read()).rejects.toThrow("upstream disconnected");
    await Promise.all(pending);
    expect(signals[0]?.aborted).toBe(true);
    expect(
      (await env.DB.prepare("SELECT output_tokens FROM usage_events").first<{ output_tokens: number }>())
        ?.output_tokens,
    ).toBe(7);
  });

  test("split UTF-8 and CRLF frames forward unchanged and retain cumulative cache usage", async () => {
    const text = (SSE_USAGE_WITH_CACHE + '\nevent: ping\ndata: {"text":"hello 🌍"}\n\n').replaceAll("\n", "\r\n");
    const bytes = new TextEncoder().encode(text);
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(bytes.subarray(offset, offset + 7));
        offset += 7;
        if (offset >= bytes.length) controller.close();
      },
    });
    const { response, pending, env, signals } = await streamingResponse(body);
    expect(await response.text()).toBe(text);
    await Promise.all(pending);
    const usage = await env.DB.prepare("SELECT * FROM usage_events").first<Record<string, unknown>>();
    expect(usage?.input_tokens).toBe(10);
    expect(usage?.output_tokens).toBe(42);
    expect(usage?.cache_creation_tokens).toBe(200);
    expect(usage?.cache_read_tokens).toBe(4000);
    expect(signals[0]?.aborted).toBe(false);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_reservations").first<{ n: number }>())?.n).toBe(0);
  });

  test("incoming request abort cancels upstream while the client is idle", async () => {
    const incoming = new AbortController();
    let cancelled = 0;
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
      },
      cancel() {
        cancelled++;
      },
    });
    const { response, pending, signals } = await streamingResponse(body, incoming.signal);
    source.enqueue(new TextEncoder().encode(start));
    await tick();
    incoming.abort(new Error("disconnected"));
    await tick();
    const observedCancellation = cancelled;
    if (!cancelled) source.close();
    await response.text().catch(() => undefined);
    await Promise.all(pending);
    expect(signals[0]?.aborted).toBe(true);
    expect(observedCancellation).toBe(1);
  });
});

test("stream deadline covers a stalled upstream fetch", async () => {
  const env = await buildTestEnv();
  const token = await seedSession(env, REPO);
  const request = new Request("https://review.test/anthropic/v1/messages", {
    method: "POST",
    headers: { "x-api-key": token },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 10, messages: [] }),
  });
  let aborted = false;
  const response = await handleAnthropic(
    request,
    env,
    {
      anthropicBaseUrl: "https://anthropic.test",
      now: Date.now,
      waitUntil: () => undefined,
      streamTimeoutMs: 20,
      fetchUpstream: ((_url, init) =>
        new Promise((_resolve, reject) => {
          const fallback = setTimeout(() => reject(new Error("test cleanup")), 100);
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              clearTimeout(fallback);
              reject(init.signal?.reason);
            },
            { once: true },
          );
        })) as typeof fetch,
    },
    new URL(request.url),
  );
  expect(response.status).toBe(502);
  expect(aborted).toBe(true);
});


test("a deleted registration refuses an existing OIDC session before forwarding", async () => {
  const env = await buildTestEnv();
  const token = await seedSession(env, REPO);
  await env.DB.prepare("DELETE FROM repos WHERE repo = ?").bind(REPO).run();
  let forwarded = false;
  const worker = createReviewWorker({ fetchUpstream: (async () => { forwarded = true; return new Response(); }) as unknown as typeof fetch });
  const response = await worker.fetch(new Request("https://review.test/anthropic/v1/messages", {
    method: "POST", headers: { "x-api-key": token }, body: "{}",
  }), env);
  expect(response.status).toBe(403);
  expect(forwarded).toBe(false);
});
