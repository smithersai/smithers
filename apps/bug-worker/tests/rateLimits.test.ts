import { describe, expect, test } from "bun:test";
import { BUG_REPORTS_PER_HOUR, clientAddress, RATE_LIMIT_PER_HOUR } from "../src/checkRateLimit.ts";
import type { BugWorkerEnv } from "../src/env.ts";
import { createBugWorker } from "../src/worker.ts";
import { memoryKv } from "./helpers/memoryKv.ts";
import { memoryRateLimits } from "./helpers/memoryDurableObjects.ts";

const worker = createBugWorker({ now: () => 1788500000000 });
const env = (): BugWorkerEnv & { BUGS: ReturnType<typeof memoryKv> } => ({
  BUGS: memoryKv(), RATE_LIMITS: memoryRateLimits(), BUG_ADMIN_TOKEN: "admin",
});
const report = (headers: Record<string, string>) => new Request("https://bug.smithers.sh/api/bugs", {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ summary: "flood" }),
});
const statuses = async (responses: Promise<Response>[]) => (await Promise.all(responses)).map((response) => response.status);
const stored = (e: ReturnType<typeof env>) => [...e.BUGS.dump().keys()].filter((key) => key.startsWith("bug:")).length;

describe("rate limits", () => {
  test("a concurrent burst from one client stores exactly the hourly budget", async () => {
    const e = env();
    const codes = await statuses(Array.from({ length: 3 * RATE_LIMIT_PER_HOUR }, () => worker.fetch(report({ "cf-connecting-ip": "203.0.113.5" }), e)));
    expect(codes.filter((code) => code === 201)).toHaveLength(RATE_LIMIT_PER_HOUR);
    expect(codes.filter((code) => code === 429)).toHaveLength(2 * RATE_LIMIT_PER_HOUR);
    expect(stored(e)).toBe(RATE_LIMIT_PER_HOUR);
  });

  test("rotating IPv6 addresses inside one /64 shares one budget", async () => {
    const e = env();
    const codes = await statuses(Array.from({ length: 2 * RATE_LIMIT_PER_HOUR }, (_, i) =>
      worker.fetch(report({ "cf-connecting-ip": `2001:db8:1:2:${i.toString(16)}::1` }), e)));
    expect(codes.filter((code) => code === 201)).toHaveLength(RATE_LIMIT_PER_HOUR);
  });

  test("x-forwarded-for never chooses the bucket", async () => {
    const e = env();
    const codes = await statuses(Array.from({ length: 2 * RATE_LIMIT_PER_HOUR }, (_, i) =>
      worker.fetch(report({ "x-forwarded-for": `198.51.100.${i}` }), e)));
    expect(codes.filter((code) => code === 201)).toHaveLength(RATE_LIMIT_PER_HOUR);
  });

  test("distinct clients together store at most the all-clients hourly cap", async () => {
    const e = env();
    const codes = await statuses(Array.from({ length: BUG_REPORTS_PER_HOUR + 50 }, (_, i) =>
      worker.fetch(report({ "cf-connecting-ip": `10.${i >> 8}.${i & 255}.1` }), e)));
    expect(codes.filter((code) => code === 201)).toHaveLength(BUG_REPORTS_PER_HOUR);
    expect(stored(e)).toBe(BUG_REPORTS_PER_HOUR);
  });

  test("an operator files while a flood holds the all-clients cap, and the refusal is logged", async () => {
    const e = env();
    const flood = await statuses(Array.from({ length: BUG_REPORTS_PER_HOUR }, (_, i) =>
      worker.fetch(report({ "cf-connecting-ip": `10.${i >> 8}.${i & 255}.1` }), e)));
    expect(flood.every((code) => code === 201)).toBe(true);
    const logged: string[] = [];
    const original = console.error;
    console.error = (line: string) => void logged.push(line);
    try {
      expect((await worker.fetch(report({ "cf-connecting-ip": "198.51.100.9" }), e)).status).toBe(429);
      expect((await worker.fetch(report({ "cf-connecting-ip": "198.51.100.9", "x-bug-admin": "admin" }), e)).status).toBe(201);
      expect((await worker.fetch(report({ "cf-connecting-ip": "198.51.100.9", "x-bug-admin": "wrong" }), e)).status).toBe(429);
    } finally {
      console.error = original;
    }
    expect(logged.map((line) => JSON.parse(line).event)).toEqual(["bug_report.global_limit", "bug_report.global_limit"]);
    expect(stored(e)).toBe(BUG_REPORTS_PER_HOUR + 1);
  });

  test("a counter charges an older hour to its stored window instead of rewinding it", async () => {
    const bucket = memoryRateLimits().getByName("bugs:all");
    const check = async (hour: number) => (await (await bucket.fetch(new Request("https://rate-limiter/", {
      method: "POST", body: JSON.stringify({ hour, limit: 2 }),
    }))).json() as { allowed: boolean }).allowed;
    expect([await check(11), await check(11), await check(11), await check(10), await check(11)])
      .toEqual([true, true, false, false, false]);
    expect([await check(12), await check(11), await check(12)]).toEqual([true, true, false]);
  });

  test("reports whose bodies arrive after the hour turns spend the new hour's budgets", async () => {
    let clock = Date.parse("2026-07-02T10:59:59.999Z");
    const late = createBugWorker({ now: () => clock });
    const e = env();
    // Requests started before the boundary; their bodies arrive later.
    const held = (ip: string) => {
      let send!: () => void;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          send = () => {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ summary: "late" })));
            controller.close();
          };
        },
      });
      const response = late.fetch(new Request("https://bug.smithers.sh/api/bugs", {
        method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body,
      }), e);
      return { send, response };
    };
    const client = Array.from({ length: 5 }, () => held("203.0.113.5"));
    const global = Array.from({ length: 5 }, (_, i) => held(`198.51.100.${i}`));
    clock += 1;
    const fresh = await statuses(Array.from({ length: RATE_LIMIT_PER_HOUR }, () => late.fetch(report({ "cf-connecting-ip": "203.0.113.5" }), e)));
    expect(fresh.every((code) => code === 201)).toBe(true);
    for (const request of client) request.send();
    expect(await statuses(client.map((request) => request.response))).toEqual(client.map(() => 429));
    const flood = await statuses(Array.from({ length: BUG_REPORTS_PER_HOUR - RATE_LIMIT_PER_HOUR }, (_, i) =>
      late.fetch(report({ "cf-connecting-ip": `10.${i >> 8}.${i & 255}.1` }), e)));
    expect(flood.every((code) => code === 201)).toBe(true);
    const logged: string[] = [];
    const original = console.error;
    console.error = (line: string) => void logged.push(line);
    try {
      for (const request of global) request.send();
      expect(await statuses(global.map((request) => request.response))).toEqual(global.map(() => 429));
    } finally {
      console.error = original;
    }
    expect(logged.map((line) => JSON.parse(line).event)).toEqual(global.map(() => "bug_report.global_limit"));
    expect(stored(e)).toBe(BUG_REPORTS_PER_HOUR);
  });

  test("the all-clients cap takes at least 100 per-client budgets to spend", () => {
    expect(BUG_REPORTS_PER_HOUR / RATE_LIMIT_PER_HOUR).toBeGreaterThanOrEqual(100);
    expect(BUG_REPORTS_PER_HOUR * 256 * 1024).toBeLessThanOrEqual(512 * 1024 * 1024);
  });

  test("a client is its IPv4 address or its IPv6 /64", () => {
    const at = (ip?: string) => clientAddress(new Request("https://x/", { headers: ip ? { "cf-connecting-ip": ip } : {} }));
    expect(at("203.0.113.5")).toBe("203.0.113.5");
    expect(at("2001:DB8:0001:0002:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(at("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(at("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(at("::1")).toBe("0:0:0:0::/64");
    expect(at("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(at()).toBe("unknown");
  });
});
