import { handleOnboardingAnswers } from "./onboardingAnswers.ts";
import type { BugWorkerEnv } from "./env.ts";
import { bugReportSchema } from "./bugReportSchema.ts";
import { newBugId } from "./newBugId.ts";
import { handleRepoClaims } from "./repoClaims.ts";
import { handleRepoRequests, retryRepoNotifications } from "./repoRequests.ts";

export type { BugWorkerEnv, BugKv } from "./env.ts";
export { RepoCompletion } from "./RepoCompletion.ts";

const MAX_PAYLOAD_BYTES = 256 * 1024;
const RATE_LIMIT_PER_HOUR = 20;

export interface BugWorkerDeps {
  now: () => number;
  fetch: typeof fetch;
}

/** Permissive on purpose: the CLI is the main client, but anyone may POST. */
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type, x-bug-admin",
  "access-control-max-age": "86400",
} as const;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

/**
 * Compare without leaking length: both sides are hashed to a fixed-size
 * digest first, so the loop below always runs 32 iterations and a timing
 * side channel cannot reveal how long the admin token is.
 */
export async function timingSafeStringEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ah, bh] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const ab = new Uint8Array(ah);
  const bb = new Uint8Array(bh);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < ab.length; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/**
 * Operator check shared by every admin route: the request must carry the
 * deployed `BUG_ADMIN_TOKEN` in `x-bug-admin`. Unset token means nobody passes.
 */
export async function isOperator(request: Request, env: BugWorkerEnv): Promise<boolean> {
  if (!env.BUG_ADMIN_TOKEN) return false;
  return timingSafeStringEqual(request.headers.get("x-bug-admin") ?? "", env.BUG_ADMIN_TOKEN);
}

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

/**
 * Read the request body while enforcing {@link MAX_PAYLOAD_BYTES}, aborting as
 * soon as the running byte count exceeds the cap so a client that omits (or
 * lies about) content-length cannot stream the whole platform body cap into
 * memory before the size check fires. Returns `null` when the cap is exceeded.
 */
export async function readBodyBounded(request: Request, maxBytes: number): Promise<string | null> {
  const body = request.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function handlePostBug(request: Request, env: BugWorkerEnv, now: number): Promise<Response> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_PAYLOAD_BYTES) {
    return json(413, { error: "payload too large", maxBytes: MAX_PAYLOAD_BYTES });
  }

  const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? "unknown";
  // A KV exception escaping the fetch handler becomes workerd's 1101 HTML
  // page; answer a clean JSON error instead.
  let allowed: boolean;
  try {
    allowed = await checkRateLimit(env, ip, now);
  } catch {
    return json(503, { error: "storage unavailable" });
  }
  if (!allowed) {
    return json(429, { error: `rate limit exceeded (${RATE_LIMIT_PER_HOUR} reports per hour per IP)` });
  }

  const raw = await readBodyBounded(request, MAX_PAYLOAD_BYTES);
  if (raw === null) {
    return json(413, { error: "payload too large", maxBytes: MAX_PAYLOAD_BYTES });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json(400, { error: "body must be JSON" });
  }
  const result = bugReportSchema.safeParse(parsed);
  if (!result.success) {
    return json(400, { error: "invalid bug report", issues: result.error.issues });
  }

  const id = newBugId(now);
  const record = { id, receivedAt: new Date(now).toISOString(), report: result.data };
  try {
    await env.BUGS.put(`bug:${id}`, JSON.stringify(record));
  } catch {
    return json(503, { error: "storage unavailable" });
  }

  const base = (env.PUBLIC_BASE_URL ?? "https://bug.smithers.sh").replace(/\/$/, "");
  return json(201, { id, url: `${base}/api/bugs/${id}` });
}

async function handleGetBug(request: Request, env: BugWorkerEnv, id: string): Promise<Response> {
  if (!(await isOperator(request, env))) {
    return json(401, { error: "x-bug-admin header required" });
  }
  let stored: string | null;
  try {
    stored = await env.BUGS.get(`bug:${id}`);
  } catch {
    return json(503, { error: "storage unavailable" });
  }
  if (stored === null) return json(404, { error: "not found" });
  return new Response(stored, {
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

/**
 * Build the worker module with explicit deps; tests inject a controllable
 * clock. The default export uses the real clock.
 */
export function defaultBugWorkerDeps(): BugWorkerDeps {
  return {
    now: () => Date.now(),
    // workerd rejects a host function invoked with a foreign `this` ("Illegal invocation"), so
    // `fetch: globalThis.fetch` breaks once routes call `deps.fetch(...)`; the arrow keeps `this` clear.
    fetch: ((input, init) => fetch(input, init)) as typeof fetch,
  };
}

export function createBugWorker(overrides?: Partial<BugWorkerDeps>) {
  const deps: BugWorkerDeps = { ...defaultBugWorkerDeps(), ...overrides };
  return {
    async scheduled(_event: unknown, env: BugWorkerEnv): Promise<void> {
      await retryRepoNotifications(env, deps);
    },
    async fetch(request: Request, env: BugWorkerEnv): Promise<Response> {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method === "GET" && url.pathname === "/healthz") {
        return json(200, { ok: true });
      }
      if (url.pathname === "/api/repo-requests" || url.pathname.startsWith("/api/repo-requests/")) {
        return handleRepoRequests(request, env, deps);
      }
      if (url.pathname === "/api/onboarding-answers") {
        return handleOnboardingAnswers(request, env, deps.now());
      }
      if (url.pathname === "/api/repo-claims") {
        return handleRepoClaims(request, env, deps);
      }
      if (request.method === "POST" && url.pathname === "/api/bugs") {
        return handlePostBug(request, env, deps.now());
      }
      const match = url.pathname.match(/^\/api\/bugs\/([A-Za-z0-9_-]+)$/);
      if (request.method === "GET" && match) {
        return handleGetBug(request, env, match[1]!);
      }
      return json(404, { error: "not found" });
    },
  };
}

export default createBugWorker();
