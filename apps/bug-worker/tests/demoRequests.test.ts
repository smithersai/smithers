import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEMO_REQUESTS_PER_HOUR, RATE_LIMIT_PER_HOUR } from "../src/checkRateLimit.ts";
import type { BugKv, BugWorkerEnv } from "../src/env.ts";
import { createBugWorker } from "../src/worker.ts";
import { memoryKv } from "./helpers/memoryKv.ts";
import { memoryRateLimits } from "./helpers/memoryDurableObjects.ts";

/**
 * The site's `/demo` form is the client of `POST /api/demo-requests`. Read the
 * endpoint and the field names from the page itself, so a renamed route or
 * field fails here instead of on every visitor's submission.
 */
const page = readFileSync(new URL("../../site/src/pages/demo/index.astro", import.meta.url), "utf8");
const endpoint = page.match(/const endpoint = "([^"]+)"/)![1]!;
const fields = [...page.matchAll(/<(?:input|textarea) name="([^"]+)"/g)].map((match) => match[1]!);

const clock = Date.parse("2026-11-12T10:00:00Z");
const worker = createBugWorker({ now: () => clock });
const env = (): BugWorkerEnv & { BUGS: ReturnType<typeof memoryKv> } => ({
  BUGS: memoryKv(), RATE_LIMITS: memoryRateLimits(), BUG_ADMIN_TOKEN: "admin",
});
const formValues: Record<string, string> = {
  firstName: "Jane", lastName: "Smith", workEmail: "jane@example.com", message: "A demo, please",
};
const post = (body: unknown, ip = "203.0.113.7") => new Request(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": ip },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const statuses = async (responses: Promise<Response>[]) => (await Promise.all(responses)).map((response) => response.status);
const stored = (e: ReturnType<typeof env>) => [...e.BUGS.dump().keys()].filter((key) => key.startsWith("demo:"));

let errors: ReturnType<typeof spyOn<Console, "error">>;
beforeEach(() => { errors = spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { errors.mockRestore(); });
const logged = () => errors.mock.calls.map((args) => JSON.parse(String(args[0])) as Record<string, unknown>);

describe("demo requests", () => {
  test("the page posts to this worker and asks for exactly the fields it stores", () => {
    expect(new URL(endpoint).origin).toBe("https://bug.smithers.sh");
    expect(fields.sort()).toEqual(Object.keys(formValues).sort());
  });

  test("the form's payload is stored and answered 201", async () => {
    const e = env();
    const payload = Object.fromEntries(fields.map((name) => [name, formValues[name]]));
    const res = await worker.fetch(post(payload), e);
    expect(res.status).toBe(201);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const { id } = (await res.json()) as { id: string };
    expect(stored(e)).toEqual([`demo:${id}`]);
    expect(JSON.parse((await e.BUGS.get(`demo:${id}`))!)).toEqual({
      id, receivedAt: "2026-11-12T10:00:00.000Z", request: formValues,
    });
  });

  test("values are trimmed and keys the form does not send are dropped", async () => {
    const e = env();
    const res = await worker.fetch(post({ ...formValues, firstName: "  Jane ", admin: true }), e);
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(JSON.parse((await e.BUGS.get(`demo:${id}`))!).request).toEqual(formValues);
  });

  test("an invalid request names its fields and stores nothing", async () => {
    const e = env();
    const res = await worker.fetch(post({ ...formValues, workEmail: "not an email", message: "   " }), e);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid demo request", fields: ["workEmail", "message"] });
    expect((await worker.fetch(post("not json"), e)).status).toBe(400);
    expect(stored(e)).toEqual([]);
  });

  test("a body over 16 KB is refused 413", async () => {
    const res = await worker.fetch(post({ ...formValues, message: "x".repeat(16 * 1024) }), env());
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload too large", maxBytes: 16 * 1024 });
  });

  test("one client stores at most its hourly budget, and refusals spend none of it", async () => {
    const e = env();
    for (let i = 0; i < 2 * RATE_LIMIT_PER_HOUR; i++) expect((await worker.fetch(post({}), e)).status).toBe(400);
    const codes = await statuses(Array.from({ length: 2 * RATE_LIMIT_PER_HOUR }, () => worker.fetch(post(formValues), e)));
    expect(codes.filter((code) => code === 201)).toHaveLength(RATE_LIMIT_PER_HOUR);
    expect(codes.filter((code) => code === 429)).toHaveLength(RATE_LIMIT_PER_HOUR);
    // Demo requests and bug reports keep separate budgets.
    const bug = new Request("https://bug.smithers.sh/api/bugs", {
      method: "POST", headers: { "cf-connecting-ip": "203.0.113.7" }, body: JSON.stringify({ summary: "still files" }),
    });
    expect((await worker.fetch(bug, e)).status).toBe(201);
  });

  test("distinct clients together store at most the all-clients cap, and the refusal is logged", async () => {
    const e = env();
    const codes = await statuses(Array.from({ length: DEMO_REQUESTS_PER_HOUR + 5 }, (_, i) =>
      worker.fetch(post(formValues, `10.0.${i}.1`), e)));
    expect(codes.filter((code) => code === 201)).toHaveLength(DEMO_REQUESTS_PER_HOUR);
    expect(stored(e)).toHaveLength(DEMO_REQUESTS_PER_HOUR);
    expect(logged().map((line) => line.event)).toEqual(Array(5).fill("demo_request.global_limit"));
  });

  test("a storage failure answers 503 and logs the route", async () => {
    const fail = async (): Promise<never> => { throw new Error("KV namespace unavailable"); };
    const offline: BugKv = { get: fail, put: fail, delete: fail };
    const res = await worker.fetch(post(formValues), { ...env(), BUGS: offline });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "storage unavailable" });
    const limiterDown = await worker.fetch(post(formValues), {
      ...env(), RATE_LIMITS: { getByName: () => ({ fetch: async () => new Response(null, { status: 500 }) }) },
    });
    expect(limiterDown.status).toBe(503);
    expect(logged()).toEqual([
      { event: "demo_request.failed", route: "POST /api/demo-requests", error: "KV namespace unavailable" },
      { event: "demo_request.failed", route: "POST /api/demo-requests", error: "Rate limiter answered 500" },
    ]);
  });
});
