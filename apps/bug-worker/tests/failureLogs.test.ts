import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createBugWorker } from "../src/worker.ts";
import type { BugKv, BugWorkerEnv } from "../src/env.ts";
import { memoryKv } from "./helpers/memoryKv.ts";
import { memoryRateLimits } from "./helpers/memoryDurableObjects.ts";

/**
 * Every 503 the Worker answers must leave one structured log line behind, so
 * Workers Logs retain the failing intake route and storage cause.
 */
const ADMIN = "test-admin";
const offline = (): BugKv => {
  const fail = async (): Promise<never> => { throw new Error("KV namespace unavailable"); };
  return { get: fail, put: fail, delete: fail, list: fail };
};

let errors: ReturnType<typeof spyOn<Console, "error">>;
beforeEach(() => { errors = spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { errors.mockRestore(); });

function logged(): Record<string, unknown>[] {
  return errors.mock.calls.map((args) => JSON.parse(String(args[0])) as Record<string, unknown>);
}

async function answer(request: Request, env: BugWorkerEnv) {
  const worker = createBugWorker({ now: () => 1788500000000 });
  return worker.fetch(request, env);
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://bug.smithers.sh${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("failure logs", () => {
  const cases: [string, () => Request, string, string][] = [
    ["bug report post", () => post("/api/bugs", { summary: "x" }), "bug_report.failed", "POST /api/bugs"],
    ["bug report read", () => new Request("https://bug.smithers.sh/api/bugs/abc123", { headers: { "x-bug-admin": ADMIN } }), "bug_report.failed", "GET /api/bugs/:id"],
    ["bug report list", () => new Request("https://bug.smithers.sh/api/bugs", { headers: { "x-bug-admin": ADMIN } }), "bug_report.failed", "GET /api/bugs"],
    ["demo request list", () => new Request("https://bug.smithers.sh/api/demo-requests", { headers: { "x-bug-admin": ADMIN } }), "demo_request.failed", "GET /api/demo-requests"],
  ];
  for (const [name, request, event, route] of cases) {
    test(`${name} logs the route template and a stable code before answering 503`, async () => {
      const response = await answer(request(), { BUGS: offline(), RATE_LIMITS: memoryRateLimits(), BUG_ADMIN_TOKEN: ADMIN });
      expect(response.status).toBe(503);
      expect(logged()).toEqual([{ event, route, code: "storage_unavailable" }]);
    });
  }

  test("an exception's own text never reaches the log", async () => {
    const secret = "https://user:token-abc123@internal.example/kv?email=jane@example.com";
    const leaky = (): BugKv => {
      const fail = async (): Promise<never> => { throw new Error(secret); };
      return { get: fail, put: fail, delete: fail, list: fail };
    };
    const limiter = { getByName: () => ({ fetch: async (): Promise<never> => { throw new Error(secret); } }) };
    await answer(post("/api/bugs", { summary: "x" }), { BUGS: leaky(), RATE_LIMITS: memoryRateLimits(), BUG_ADMIN_TOKEN: ADMIN });
    await answer(post("/api/bugs", { summary: "x" }), { BUGS: memoryKv(), RATE_LIMITS: limiter, BUG_ADMIN_TOKEN: ADMIN });
    expect(logged()).toEqual([
      { event: "bug_report.failed", route: "POST /api/bugs", code: "storage_unavailable" },
      { event: "bug_report.failed", route: "POST /api/bugs", code: "rate_limiter_unavailable" },
    ]);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("token-abc123");
  });

  test("a report write failure after rate-limit admission returns one storage refusal", async () => {
    const kv = memoryKv();
    const writes: string[] = [];
    const env: BugWorkerEnv = {
      BUGS: { ...kv, put: async (key, value, options) => {
        writes.push(key);
        if (key.startsWith("bug:")) throw new Error("report write unavailable");
        await kv.put(key, value, options);
      } },
      RATE_LIMITS: memoryRateLimits(), BUG_ADMIN_TOKEN: ADMIN,
    };
    const response = await answer(post("/api/bugs", { summary: "lost report" }), env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "storage unavailable" });
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(writes).toEqual([expect.stringMatching(/^bug:/)]);
    const reports = writes.filter(key => key.startsWith("bug:"));
    expect(reports).toHaveLength(1);
    expect(await kv.get(reports[0]!)).toBeNull();
    expect(logged()).toEqual([{ event: "bug_report.failed", route: "POST /api/bugs", code: "storage_unavailable" }]);
  });

});
