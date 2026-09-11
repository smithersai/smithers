import { handleOnboardingAnswers } from "./onboardingAnswers.ts";
import type { BugWorkerDeps } from "./deps.ts";
import type { BugWorkerEnv } from "./env.ts";
import { bugReportSchema } from "./bugReportSchema.ts";
import { checkRateLimit, RATE_LIMIT_PER_HOUR } from "./checkRateLimit.ts";
import { isOperator } from "./isOperator.ts";
import { newBugId } from "./newBugId.ts";
import { readBodyBounded } from "./readBodyBounded.ts";
import { handleRepoClaims } from "./repoClaims.ts";
import { handleRepoRequests, retryRepoNotifications } from "./repoRequests.ts";

export type { BugWorkerDeps } from "./deps.ts";
export type { BugWorkerEnv, BugKv } from "./env.ts";
export { RepoCompletion } from "./RepoCompletion.ts";

const MAX_PAYLOAD_BYTES = 256 * 1024;

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
