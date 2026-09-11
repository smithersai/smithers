import type { BugWorkerEnv } from "./env.ts";

/** Default budget: accepted writes per IP per hour, per route bucket. */
export const RATE_LIMIT_PER_HOUR = 20;

/**
 * Best-effort per-IP throttle. KV has no atomic increment and up to ~60s of
 * propagation, so this is a read-modify-write that concurrent bursts from one
 * IP can race past — the 20/hour is advisory, a speed bump against accidental
 * floods, not a hard security boundary. For a strict limit, back the counter
 * with a Durable Object or a Cloudflare Rate Limiting binding.
 */
export async function checkRateLimit(env: BugWorkerEnv, ip: string, now: number, limit = RATE_LIMIT_PER_HOUR): Promise<boolean> {
  const hourBucket = Math.floor(now / 3_600_000);
  const key = `ratelimit:${ip}:${hourBucket}`;
  const count = Number((await env.BUGS.get(key)) ?? "0");
  if (count >= limit) return false;
  await env.BUGS.put(key, String(count + 1), { expirationTtl: 3600 });
  return true;
}
