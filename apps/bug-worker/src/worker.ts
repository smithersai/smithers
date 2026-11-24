import type { BugWorkerDeps } from "./deps.ts";
import type { BugWorkerEnv } from "./env.ts";
import { bugReportSchema } from "./bugReportSchema.ts";
import type { z } from "zod";
import { admit, BUG_REPORTS_PER_HOUR, DEMO_REQUESTS_PER_HOUR, RATE_LIMIT_PER_HOUR, RateLimiterUnavailable } from "./checkRateLimit.ts";
import { demoSubmissionSchema } from "./demoRequestSchema.ts";
import { isOperator } from "./isOperator.ts";
import { type FailureCode, logAccepted, logFailure } from "./logFailure.ts";
import { newBugId } from "./newBugId.ts";
import { publicBaseUrl } from "./publicBaseUrl.ts";
import { readBodyBounded } from "./readBodyBounded.ts";

export type { BugWorkerDeps } from "./deps.ts";
export type { BugWorkerEnv, BugKv } from "./env.ts";
export { RateLimiter } from "./RateLimiter.ts";

const MAX_PAYLOAD_BYTES = 256 * 1024;
/** A demo request is four short form fields; 16 KB holds the longest valid one. */
const MAX_DEMO_REQUEST_BYTES = 16 * 1024;

/**
 * Stored demo requests and their receipts expire after 90 days: a name, work
 * email and message are kept long enough to answer, not indefinitely.
 */
export const DEMO_REQUEST_TTL_SECONDS = 90 * 24 * 60 * 60;
/** The most IDs one operator list answers; KV allows up to 1000. */
const LIST_LIMIT = 100;

/**
 * Permissive on purpose for anonymous intake: the CLI is the main client, but
 * anyone may POST. Operator reads carry none of these: they are not meant for
 * a browser on another origin.
 */
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
} as const;

/** Operator answers hold private submissions: never cached, never sniffed. */
const OPERATOR_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
} as const;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff", ...CORS_HEADERS },
  });
}

function operatorJson(status: number, body: string): Response {
  return new Response(body, { status, headers: OPERATOR_HEADERS });
}

/** The stable failure code for an exception thrown during intake or a read. */
function failureCode(error: unknown): FailureCode {
  return error instanceof RateLimiterUnavailable ? "rate_limiter_unavailable" : "storage_unavailable";
}

/**
 * Read a JSON body of at most `maxBytes` and validate it against `schema`.
 * Answers the 413 or 400 refusal instead when the body is too large, is not
 * JSON, or fails the schema.
 */
async function readIntake<T>(request: Request, maxBytes: number, schema: z.ZodType<T>, invalid: string): Promise<{ data: T } | Response> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > maxBytes) {
    return json(413, { error: "payload too large", maxBytes });
  }

  const raw = await readBodyBounded(request, maxBytes);
  if (raw === null) {
    return json(413, { error: "payload too large", maxBytes });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json(400, { error: "body must be JSON" });
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    // Field paths only: a schema library's own messages are jargon, never a reply.
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.map(String).join(".") || "(body)"))];
    return json(400, { error: invalid, fields });
  }
  return { data: result.data };
}

async function handlePostBug(request: Request, env: BugWorkerEnv, now: number): Promise<Response> {
  const route = "POST /api/bugs";
  const result = await readIntake(request, MAX_PAYLOAD_BYTES, bugReportSchema, "invalid bug report");
  if (result instanceof Response) return result;

  // The budgets count valid reports only, so rejected requests never spend a
  // reporter's hourly quota; `admit` charges the all-clients cap first, so a
  // flood's refusals never spend it either. A storage exception escaping the
  // fetch handler becomes workerd's 1101 HTML page; answer a clean JSON error
  // instead. An operator skips both budgets, so triage can still file during
  // a flood that has spent the all-clients cap.
  let admitted: "yes" | "client" | "all";
  try {
    admitted = await isOperator(request, env) ? "yes" : await admit(env, "bugs", request, now, BUG_REPORTS_PER_HOUR);
  } catch (error) {
    logFailure("bug_report.failed", route, failureCode(error));
    return json(503, { error: "storage unavailable" });
  }
  if (admitted === "client") {
    return json(429, { error: `rate limit exceeded (${RATE_LIMIT_PER_HOUR} reports per hour per IP)` });
  }
  if (admitted === "all") {
    logFailure("bug_report.global_limit", route, "global_limit");
    return json(429, { error: "rate limit exceeded (too many reports this hour; try again later)" });
  }

  const id = newBugId(now);
  const record = { id, receivedAt: new Date(now).toISOString(), report: result.data };
  try {
    await env.BUGS.put(`bug:${id}`, JSON.stringify(record));
  } catch {
    logFailure("bug_report.failed", route, "storage_unavailable");
    return json(503, { error: "storage unavailable" });
  }

  logAccepted("bug_report.accepted", route, id);
  return json(201, { id, url: `${publicBaseUrl(env, request)}/api/bugs/${id}` });
}

/** A stored receipt holds the ID it was issued for; anything else is not one. */
const ID_FORMAT = /^[0-9a-z]{26}$/;

/**
 * Store one `/demo` form submission as `demo:<id>` and answer its receipt,
 * `201 {id}`. Anonymous like bug intake, and bounded the same way: a valid
 * request spends the client's hourly budget and the all-clients cap; a 400
 * or 413 spends neither.
 *
 * Idempotent per `submissionId`: `demo-receipt:<submissionId>` is written
 * before the request, so a retry after a lost response, or after a request
 * write that failed, answers the original ID, repairs a missing request, and
 * spends no second admission.
 */
async function handlePostDemoRequest(request: Request, env: BugWorkerEnv, now: number): Promise<Response> {
  const route = "POST /api/demo-requests";
  const result = await readIntake(request, MAX_DEMO_REQUEST_BYTES, demoSubmissionSchema, "invalid demo request");
  if (result instanceof Response) return result;
  const { submissionId, ...form } = result.data;
  const receiptKey = `demo-receipt:${submissionId}`;
  const store = (id: string) => env.BUGS.put(
    `demo:${id}`,
    JSON.stringify({ id, receivedAt: new Date(now).toISOString(), request: form }),
    { expirationTtl: DEMO_REQUEST_TTL_SECONDS },
  );

  let receipt: string | null;
  try {
    receipt = await env.BUGS.get(receiptKey);
    if (receipt !== null && ID_FORMAT.test(receipt)) {
      if ((await env.BUGS.get(`demo:${receipt}`)) === null) await store(receipt);
      logAccepted("demo_request.replayed", route, receipt);
      return json(201, { id: receipt });
    }
  } catch {
    logFailure("demo_request.failed", route, "storage_unavailable");
    return json(503, { error: "storage unavailable" });
  }

  let admitted: "yes" | "client" | "all";
  try {
    admitted = await admit(env, "demo", request, now, DEMO_REQUESTS_PER_HOUR);
  } catch (error) {
    logFailure("demo_request.failed", route, failureCode(error));
    return json(503, { error: "storage unavailable" });
  }
  if (admitted === "client") {
    return json(429, { error: `rate limit exceeded (${RATE_LIMIT_PER_HOUR} demo requests per hour per IP)` });
  }
  if (admitted === "all") {
    logFailure("demo_request.global_limit", route, "global_limit");
    return json(429, { error: "rate limit exceeded (too many demo requests this hour; try again later)" });
  }

  const id = newBugId(now);
  try {
    await env.BUGS.put(receiptKey, id, { expirationTtl: DEMO_REQUEST_TTL_SECONDS });
    await store(id);
  } catch {
    logFailure("demo_request.failed", route, "storage_unavailable");
    return json(503, { error: "storage unavailable" });
  }

  logAccepted("demo_request.accepted", route, id);
  return json(201, { id });
}

/** Operator read of one stored record: `bug:<id>` or `demo:<id>`. */
async function handleGetRecord(request: Request, env: BugWorkerEnv, kind: "bug" | "demo", id: string): Promise<Response> {
  const route = kind === "bug" ? "GET /api/bugs/:id" : "GET /api/demo-requests/:id";
  if (!(await isOperator(request, env))) {
    return operatorJson(401, JSON.stringify({ error: "x-bug-admin header required" }));
  }
  let stored: string | null;
  try {
    stored = await env.BUGS.get(`${kind}:${id}`);
  } catch {
    logFailure(kind === "bug" ? "bug_report.failed" : "demo_request.failed", route, "storage_unavailable");
    return operatorJson(503, JSON.stringify({ error: "storage unavailable" }));
  }
  if (stored === null) return operatorJson(404, JSON.stringify({ error: "not found" }));
  return operatorJson(200, stored);
}

/**
 * Operator list of stored IDs, oldest first (IDs sort by time). Answers
 * `{ids, cursor?}`; pass `?cursor=` to read the next page.
 */
async function handleList(request: Request, env: BugWorkerEnv, kind: "bug" | "demo"): Promise<Response> {
  const route = kind === "bug" ? "GET /api/bugs" : "GET /api/demo-requests";
  if (!(await isOperator(request, env))) {
    return operatorJson(401, JSON.stringify({ error: "x-bug-admin header required" }));
  }
  const cursor = new URL(request.url).searchParams.get("cursor") ?? undefined;
  try {
    const page = await env.BUGS.list({ prefix: `${kind}:`, limit: LIST_LIMIT, ...(cursor ? { cursor } : {}) });
    const ids = page.keys.map((key) => key.name.slice(kind.length + 1));
    return operatorJson(200, JSON.stringify(page.list_complete ? { ids } : { ids, cursor: page.cursor }));
  } catch {
    logFailure(kind === "bug" ? "bug_report.failed" : "demo_request.failed", route, "storage_unavailable");
    return operatorJson(503, JSON.stringify({ error: "storage unavailable" }));
  }
}

/**
 * Build the worker module with explicit deps; tests inject a controllable
 * clock. The default export uses the real clock.
 */
export function defaultBugWorkerDeps(): BugWorkerDeps {
  return {
    now: () => Date.now(),
  };
}

export function createBugWorker(overrides?: Partial<BugWorkerDeps>) {
  const deps: BugWorkerDeps = { ...defaultBugWorkerDeps(), ...overrides };
  return {
    async fetch(request: Request, env: BugWorkerEnv): Promise<Response> {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      if (request.method === "GET" && url.pathname === "/healthz") {
        return json(200, { ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/bugs") {
        return handlePostBug(request, env, deps.now());
      }
      if (request.method === "POST" && url.pathname === "/api/demo-requests") {
        return handlePostDemoRequest(request, env, deps.now());
      }
      if (request.method === "GET" && url.pathname === "/api/bugs") {
        return handleList(request, env, "bug");
      }
      if (request.method === "GET" && url.pathname === "/api/demo-requests") {
        return handleList(request, env, "demo");
      }
      const match = url.pathname.match(/^\/api\/(bugs|demo-requests)\/([A-Za-z0-9_-]+)$/);
      if (request.method === "GET" && match) {
        return handleGetRecord(request, env, match[1] === "bugs" ? "bug" : "demo", match[2]!);
      }
      return json(404, { error: "not found" });
    },
  };
}

export default createBugWorker();
