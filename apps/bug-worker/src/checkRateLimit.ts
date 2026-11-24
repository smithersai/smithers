import type { BugWorkerEnv } from "./env.ts";
/**
 * The worker's request. A charge (the default) admits and counts one request
 * against `limit` for `hour`; a refund returns one admission charged to `hour`.
 */
export type RateLimitRequest =
  | { op?: "charge"; hour: number; limit: number }
  | { op: "refund"; hour: number };
/** The answer to a charge: whether it was admitted, and the hour it was charged to. */
export type RateLimitAnswer = { allowed: boolean; hour: number };

/**
 * Accepted bug reports per hour across all clients. Rotating addresses defeats
 * any per-client budget, so this bounds the KV bytes anonymous intake can add:
 * at most this many 256 KB reports (500 MB) an hour. It sits far above organic
 * volume so a flood needs 100 clients to spend it; operators bypass it, and a
 * refusal logs `bug_report.global_limit` so the flood is visible.
 */
export const BUG_REPORTS_PER_HOUR = 2000;
/**
 * Accepted demo requests per hour across all clients: at most 200 16 KB
 * requests (3.2 MB) an hour, far above what a sales inbox receives.
 */
export const DEMO_REQUESTS_PER_HOUR = 200;
/** Default budget: accepted writes per client per hour, per route bucket. */
export const RATE_LIMIT_PER_HOUR = 20;
/**
 * The client a request is charged to. Only Cloudflare's `cf-connecting-ip` is
 * trusted: `x-forwarded-for` is caller-written. An IPv6 client is charged per
 * /64, the smallest prefix one subscriber is routinely assigned, so rotating
 * addresses inside it shares one budget.
 */
export function clientAddress(request: Request): string {
  const ip = request.headers.get("cf-connecting-ip")?.trim().toLowerCase();
  if (!ip) return "unknown";
  if (!ip.includes(":")) return ip;
  // An IPv4-mapped address (::ffff:192.0.2.1) is charged to its IPv4 address.
  if (ip.includes(".")) return ip.slice(ip.lastIndexOf(":") + 1);
  const [head = "", tail] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** The rate limiter could not answer: its Durable Object threw or answered a non-2xx status. */
export class RateLimiterUnavailable extends Error {
  constructor() {
    super("rate limiter unavailable");
  }
}

async function call(env: BugWorkerEnv, bucket: string, body: RateLimitRequest): Promise<unknown> {
  let answer: Response;
  try {
    answer = await env.RATE_LIMITS.getByName(bucket).fetch(new Request("https://rate-limiter/", { method: "POST", body: JSON.stringify(body) }));
  } catch {
    throw new RateLimiterUnavailable();
  }
  if (!answer.ok) throw new RateLimiterUnavailable();
  return answer.json();
}

/**
 * Admit one request against `bucket`'s hourly budget. The count lives in the
 * `RateLimiter` Durable Object named by the bucket, which increments it
 * atomically, so a concurrent burst gets exactly `limit` admissions. Answers
 * the hour the admission was charged to, which a refund names.
 */
export async function checkRateLimit(env: BugWorkerEnv, bucket: string, now: number, limit = RATE_LIMIT_PER_HOUR): Promise<RateLimitAnswer> {
  return await call(env, bucket, { hour: Math.floor(now / 3_600_000), limit }) as RateLimitAnswer;
}

/** Return one admission charged to `hour` after a later budget refused the request. */
export async function refundRateLimit(env: BugWorkerEnv, bucket: string, hour: number): Promise<void> {
  await call(env, bucket, { op: "refund", hour });
}

/**
 * Charge the all-clients cap, then the client's budget. A request the cap
 * refuses spends none of the client's budget, so a flood cannot use up a
 * legitimate reporter's hour. A request the client's budget refuses has its
 * cap admission refunded, so one client cannot spend the cap either.
 * Throws `RateLimiterUnavailable`.
 */
export async function admit(env: BugWorkerEnv, route: "bugs" | "demo", request: Request, now: number, cap: number): Promise<"yes" | "client" | "all"> {
  const all = await checkRateLimit(env, `${route}:all`, now, cap);
  if (!all.allowed) return "all";
  const client = await checkRateLimit(env, `${route}:${clientAddress(request)}`, now);
  if (client.allowed) return "yes";
  await refundRateLimit(env, `${route}:all`, all.hour);
  return "client";
}
