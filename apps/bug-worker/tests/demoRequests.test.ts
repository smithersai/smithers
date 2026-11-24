import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEMO_REQUESTS_PER_HOUR, RATE_LIMIT_PER_HOUR } from "../src/checkRateLimit.ts";
import type { BugKv } from "../src/env.ts";
import { createBugWorker } from "../src/worker.ts";
import { DEMO_REQUEST_TTL_SECONDS } from "../src/demoReceipt.ts";
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
const env = (kv = memoryKv(), charge?: Parameters<typeof memoryRateLimits>[1]) => ({
  BUGS: kv, RATE_LIMITS: memoryRateLimits(kv, charge), BUG_ADMIN_TOKEN: "admin",
});
const formValues: Record<string, string> = {
  firstName: "Jane", lastName: "Smith", workEmail: "jane@example.com", message: "A demo, please",
};
/** A fresh idempotency key per call, as the page draws one per submission. */
const submission = () => crypto.randomUUID();
const post = (body: unknown, ip = "203.0.113.7") => new Request(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": ip },
  body: typeof body === "string" ? body
    : JSON.stringify(typeof body === "object" && body !== null && !("submissionId" in body) ? { ...body, submissionId: submission() } : body),
});
const statuses = async (responses: Promise<Response>[]) => (await Promise.all(responses)).map((response) => response.status);
const stored = (e: ReturnType<typeof env>) => [...e.BUGS.dump().keys()].filter((key) => key.startsWith("demo:"));

let errors: ReturnType<typeof spyOn<Console, "error">>;
beforeEach(() => { errors = spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { errors.mockRestore(); });
let infos: ReturnType<typeof spyOn<Console, "log">>;
beforeEach(() => { infos = spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { infos.mockRestore(); });
const logged = () => errors.mock.calls.map((args) => JSON.parse(String(args[0])) as Record<string, unknown>);
const accepted = () => infos.mock.calls.map((args) => JSON.parse(String(args[0])) as Record<string, unknown>);

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
    const keyless = await worker.fetch(post(JSON.stringify(formValues)), e);
    expect(await keyless.json()).toEqual({ error: "invalid demo request", fields: ["submissionId"] });
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

  test("a form completed after the hour changes spends the current hour's admission", async () => {
    const e = env();
    let now = clock;
    const timed = createBugWorker({ now: () => now });
    let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        finish = () => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ ...formValues, submissionId: submission() })));
          controller.close();
        };
      },
    });
    const pending = timed.fetch(new Request(endpoint, { method: "POST", body }), e);
    now += 3_600_000;
    finish();
    expect((await pending).status).toBe(201);
    expect(e.RATE_LIMITS.stored("demo-hour:" + Math.floor(clock / 3_600_000)).size).toBe(0);
    expect(e.RATE_LIMITS.stored("demo-hour:" + Math.floor(now / 3_600_000)).get("total")).toBe(1);
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
    const offline: BugKv = { get: fail, put: fail, delete: fail, list: fail };
    const res = await worker.fetch(post(formValues), { ...env(), BUGS: offline, RATE_LIMITS: memoryRateLimits(offline) });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "storage unavailable" });
    const limiterDown = await worker.fetch(post(formValues), {
      ...env(), RATE_LIMITS: { getByName: () => ({ fetch: async () => new Response(null, { status: 500 }) }) },
    });
    expect(limiterDown.status).toBe(503);
    expect(logged()).toEqual([
      { event: "demo_request.failed", route: "POST /api/demo-requests", code: "storage_unavailable" },
      { event: "demo_request.failed", route: "POST /api/demo-requests", code: "rate_limiter_unavailable" },
    ]);
  });

  test("a retry after a lost response answers the original id, stores one request, and spends one admission", async () => {
    const e = env();
    const body = { ...formValues, submissionId: submission() };
    const first = await worker.fetch(post(body), e);
    expect(first.status).toBe(201);
    const { id } = (await first.json()) as { id: string };
    // The response was lost; the page resends the same submission.
    const retry = await worker.fetch(post(body), e);
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual({ id });
    expect(stored(e)).toEqual([`demo:${id}`]);
    expect(e.RATE_LIMITS.stored("demo-hour:" + Math.floor(clock / 3_600_000)).get("total")).toBe(1);
    expect(accepted()).toEqual([
      { event: "demo_request.accepted", route: "POST /api/demo-requests", id },
      { event: "demo_request.replayed", route: "POST /api/demo-requests", id },
    ]);
  });

  test("simultaneous deliveries of the same canonical form write one lead and charge one admission", async () => {
    const kv = memoryKv();
    const put = spyOn(kv, "put");
    const e = env(kv);
    const submissionId = submission();
    const responses = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      worker.fetch(post({ ...formValues, firstName: i % 2 ? "  Jane" : "Jane", ignored: i, submissionId }), e)));
    const receipts = await Promise.all(responses.map((r) => r.text()));
    expect(responses.every((r) => r.status === 201)).toBe(true);
    expect(new Set(receipts).size).toBe(1);
    expect(stored(e)).toEqual(["demo:" + JSON.parse(receipts[0]!).id]);
    expect(put).toHaveBeenCalledTimes(1);
    const charges = e.RATE_LIMITS.stored("demo-hour:" + Math.floor(clock / 3_600_000));
    expect(charges.get("total")).toBe(1);
    expect([...charges].filter(([key]) => key.startsWith("client:")).map(([, count]) => count)).toEqual([1]);
    expect((await worker.fetch(post({ ...formValues, submissionId, message: "changed" }), e)).status).toBe(409);
    expect(put).toHaveBeenCalledTimes(1);
    expect(JSON.parse((await kv.get(stored(e)[0]!))!).request).toEqual(formValues);
  });

  test("losing the admission reply across an hour boundary preserves the ticket and original receipt", async () => {
    let loseReply = true;
    const e = env(memoryKv(), async (charge) => {
      const result = await charge();
      if (loseReply) { loseReply = false; throw new Error("reply lost"); }
      return result;
    });
    const body = { ...formValues, submissionId: submission() };
    expect((await worker.fetch(post(body), e)).status).toBe(503);
    const later = createBugWorker({ now: () => clock + 3_600_000 });
    expect((await later.fetch(post({ ...body, lastName: "Jones" }), e)).status).toBe(409);
    const retry = await later.fetch(post(body, "198.51.100.1"), e);
    expect(retry.status).toBe(201);
    const { id } = await retry.json();
    expect(JSON.parse((await e.BUGS.get("demo:" + id))!).receivedAt).toBe(new Date(clock).toISOString());
    const hour = Math.floor(clock / 3_600_000);
    expect(e.RATE_LIMITS.stored("demo-hour:" + hour).get("total")).toBe(1);
    expect(e.RATE_LIMITS.stored("demo-hour:" + (hour + 1)).size).toBe(0);
  });

  test("a pre-upgrade receipt is bound to its stored form and never registers a second lead", async () => {
    const e = env();
    const submissionId = submission();
    const id = "01kabcdefghjkmnpqrstvwxyz0";
    await e.BUGS.put("demo-receipt:" + submissionId, id);
    const body = { ...formValues, submissionId };
    expect((await worker.fetch(post(body), e)).status).toBe(503);
    await e.BUGS.put("demo:" + id, JSON.stringify({ id, receivedAt: new Date(clock).toISOString(), request: formValues }));
    expect((await worker.fetch(post({ ...body, lastName: "Jones" }), e)).status).toBe(409);
    const replay = await worker.fetch(post(body), e);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual({ id });
    expect(stored(e)).toEqual(["demo:" + id]);
    expect(e.RATE_LIMITS.stored("demo-hour:" + Math.floor(clock / 3_600_000)).size).toBe(0);
  });

  test("a retry after the request write failed stores it under the receipt's id", async () => {
    const kv = memoryKv();
    let failNext = true;
    const flaky: BugKv = { ...kv, put: async (key, value, options) => {
      if (key.startsWith("demo:") && failNext) { failNext = false; throw new Error("write lost"); }
      await kv.put(key, value, options);
    } };
    const e = env(Object.assign(flaky, { dump: kv.dump }));
    const body = { ...formValues, submissionId: submission() };
    expect((await worker.fetch(post(body), e)).status).toBe(503);
    expect((await worker.fetch(post({ ...body, message: "different lead" }), e)).status).toBe(409);
    expect(stored(e)).toEqual([]);
    const retry = await worker.fetch(post(body), e);
    expect(retry.status).toBe(201);
    const { id } = (await retry.json()) as { id: string };
    expect(stored(e)).toEqual([`demo:${id}`]);
    expect(JSON.parse((await kv.get(`demo:${id}`))!).request).toEqual(formValues);
  });

  test("stored requests and receipts expire", async () => {
    let now = clock;
    const kv = memoryKv(() => now);
    const e = env(kv);
    const body = { ...formValues, submissionId: submission() };
    const { id } = (await (await worker.fetch(post(body), e)).json()) as { id: string };
    now += (DEMO_REQUEST_TTL_SECONDS - 1) * 1000;
    expect(await kv.get(`demo:${id}`)).not.toBeNull();
    now += 1000;
    expect(await kv.get(`demo:${id}`)).toBeNull();
    const receiptKey = "demo-receipt:" + body.submissionId;
    expect(e.RATE_LIMITS.alarmAt(receiptKey)).toBe(now);
    await e.RATE_LIMITS.fireAlarms(now - 1);
    expect(e.RATE_LIMITS.stored(receiptKey).size).toBe(1);
    await e.RATE_LIMITS.fireAlarms(now);
    expect(e.RATE_LIMITS.stored(receiptKey).size).toBe(0);
  });

  test("an operator lists and reads demo requests; anyone else gets 401", async () => {
    const e = env();
    const { id } = (await (await worker.fetch(post(formValues), e)).json()) as { id: string };
    const admin = { "x-bug-admin": "admin" };
    expect((await worker.fetch(new Request(endpoint), e)).status).toBe(401);
    expect((await worker.fetch(new Request(`${endpoint}/${id}`), e)).status).toBe(401);
    const listed = await worker.fetch(new Request(endpoint, { headers: admin }), e);
    expect(listed.headers.get("cache-control")).toBe("private, no-store");
    expect(await listed.json()).toEqual({ ids: [id] });
    const read = await worker.fetch(new Request(`${endpoint}/${id}`, { headers: admin }), e);
    expect((await read.json()).request).toEqual(formValues);
  });

  test("caps repeated replays of the same submissionId without hitting KV", async () => {
    const kv = memoryKv();
    let kvGets = 0;
    const countedKv = {
      ...kv,
      get: async (key: string) => { kvGets++; return kv.get(key); },
      put: kv.put,
      list: kv.list,
      dump: kv.dump,
    };
    const e = env(countedKv);
    const body = { ...formValues, submissionId: submission() };
    const first = await worker.fetch(post(body), e);
    expect(first.status).toBe(201);
    const getsAfterFirst = kvGets;
    for (let i = 0; i < RATE_LIMIT_PER_HOUR; i++) {
      const replay = await worker.fetch(post(body), e);
      expect(replay.status).toBe(201);
    }
    const capped = await worker.fetch(post(body), e);
    expect(capped.status).toBe(429);
    expect(kvGets).toBe(getsAfterFirst);
  });
});
