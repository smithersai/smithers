/**
 * Redirect hardening for the Anthropic proxy: the injected upstream key must
 * never travel to any origin other than the configured anthropicBaseUrl, no
 * matter what Location headers the upstream answers with. Real Bun servers on
 * two distinct origins (different 127.0.0.1 ports) — no mocking of the fetch
 * under test.
 */
import { afterEach, describe, expect, test } from "bun:test";
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
  "event: message_delta",
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":300,"output_tokens":42}}',
  "",
  "event: message_stop",
  'data: {"type":"message_stop"}',
  "",
].join("\n");

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

const teardowns: (() => void)[] = [];
afterEach(() => {
  while (teardowns.length) teardowns.pop()!();
});

function makeWorker(anthropicBaseUrl: string, waitUntil: (p: Promise<unknown>) => void = () => undefined) {
  return createReviewWorker({
    jwksUrl: "http://unused",
    anthropicBaseUrl,
    fetchUpstream: fetch,
    now: () => Date.now(),
    waitUntil,
  });
}

function proxyRequest(token: string) {
  return new Request("https://review.test/anthropic/v1/messages", {
    method: "POST",
    headers: { "x-api-key": token, "content-type": "application/json" },
    body: '{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[]}',
  });
}

describe("anthropic proxy redirect hardening", () => {
  test("refuses a cross-origin redirect: the foreign origin never sees the request or the key", async () => {
    const env = await buildTestEnv();
    // A second REAL server on a different origin — where a hostile upstream
    // tries to bounce the proxy (and, pre-fix, the injected x-api-key).
    const foreign = serveFixtureAnthropic({ contentType: "application/json", body: '{"ok":true}' });
    teardowns.push(() => foreign.stop());
    const upstream = serveFixtureAnthropic(() => ({
      status: 302,
      contentType: "application/json",
      body: "",
      headers: { location: `${foreign.baseUrl}/v1/messages` },
    }));
    teardowns.push(() => upstream.stop());
    const token = await seedSession(env, REPO);
    const worker = makeWorker(upstream.baseUrl);

    const res = await worker.fetch(proxyRequest(token), env);
    expect(res.status).toBe(502);
    const text = await res.text();
    // The upstream key must not leak into the error surface either.
    expect(text).not.toContain("sk-ant-test");
    const body = JSON.parse(text) as { error: string; location: string };
    expect(body.error).toContain("refusing to forward credentials");
    expect(body.location).toBe(new URL(foreign.baseUrl).origin);
    // The configured origin got the key (hop 1); the foreign origin got NOTHING.
    expect(upstream.requests.length).toBe(1);
    expect(upstream.requests[0].headers["x-api-key"]).toBe("sk-ant-test");
    expect(foreign.requests.length).toBe(0);
  });

  test("follows a same-origin 307 redirect, preserving method, body, streaming, and metering", async () => {
    const env = await buildTestEnv();
    const upstream = serveFixtureAnthropic((req) =>
      new URL(req.url).pathname === "/v1/messages"
        ? {
            status: 307,
            contentType: "application/json",
            body: "",
            // Relative Location — must resolve against the current hop URL.
            headers: { location: "/v1/messages-moved" },
          }
        : { contentType: "text/event-stream", body: SSE_USAGE },
    );
    teardowns.push(() => upstream.stop());
    const token = await seedSession(env, REPO);
    const meterings: Promise<unknown>[] = [];
    const worker = makeWorker(upstream.baseUrl, (p) => meterings.push(p));

    const res = await worker.fetch(proxyRequest(token), env);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("message_start");
    // Both hops stayed on the configured origin and carried the real key;
    // 307 replays the method and body unchanged.
    expect(upstream.requests.length).toBe(2);
    expect(upstream.requests[0].headers["x-api-key"]).toBe("sk-ant-test");
    expect(upstream.requests[1].headers["x-api-key"]).toBe("sk-ant-test");
    expect(new URL(upstream.requests[1].url).pathname).toBe("/v1/messages-moved");
    expect(upstream.requests[1].method).toBe("POST");
    expect(upstream.requests[1].body).toBe('{"model":"claude-sonnet-4-6","max_tokens":1024,"messages":[]}');
    // The redirected stream still meters.
    await Promise.all(meterings);
    const row = await env.DB.prepare("SELECT * FROM usage_events").first<Record<string, unknown>>();
    expect(row?.kind).toBe("messages_stream");
    expect(row?.input_tokens).toBe(300);
    expect(row?.output_tokens).toBe(42);
  });

  test("re-issues a same-origin 302 of a POST as a bodyless GET (fetch redirect semantics)", async () => {
    const env = await buildTestEnv();
    const upstream = serveFixtureAnthropic((req) =>
      new URL(req.url).pathname === "/v1/messages"
        ? {
            status: 302,
            contentType: "application/json",
            body: "",
            headers: { location: "/v1/messages-moved" },
          }
        : { contentType: "application/json", body: '{"id":"x","content":[]}' },
    );
    teardowns.push(() => upstream.stop());
    const token = await seedSession(env, REPO);
    const worker = makeWorker(upstream.baseUrl);

    const res = await worker.fetch(proxyRequest(token), env);
    expect(res.status).toBe(200);
    await res.text();
    expect(upstream.requests.length).toBe(2);
    expect(upstream.requests[1].method).toBe("GET");
    expect(upstream.requests[1].body).toBe("");
    expect(upstream.requests[1].headers["content-type"]).toBeUndefined();
    expect(upstream.requests[1].headers["x-api-key"]).toBe("sk-ant-test");
  });

  test("502s a same-origin redirect loop after the hop cap instead of spinning", async () => {
    const env = await buildTestEnv();
    const upstream = serveFixtureAnthropic(() => ({
      status: 302,
      contentType: "application/json",
      body: "",
      headers: { location: "/v1/messages" },
    }));
    teardowns.push(() => upstream.stop());
    const token = await seedSession(env, REPO);
    const worker = makeWorker(upstream.baseUrl);

    const res = await worker.fetch(proxyRequest(token), env);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("too many upstream redirects");
    expect(upstream.requests.length).toBe(5);
  });
});
