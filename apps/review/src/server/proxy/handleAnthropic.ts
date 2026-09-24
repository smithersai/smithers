import type { ReviewWorkerEnv } from "../env.ts";
import { jsonError } from "../jsonError.ts";
import { assertRepoUnderMonthlyCap } from "../assertRepoUnderMonthlyCap.ts";
import { lookupRepo } from "../sessions/lookupRepo.ts";
import { anthropicEndpointAllowed } from "./anthropicEndpointAllowed.ts";
import { authenticateProxyRequest } from "./authenticateProxyRequest.ts";
import { teeForMetering } from "./teeForMetering.ts";
import { randomTokenHex } from "../randomTokenHex.ts";
import { modelPrices } from "./modelPrices.ts";
import { priceRequest } from "./priceRequest.ts";
import { reserveUsage } from "./reserveUsage.ts";
import { PROXY_IN_FLIGHT_LIMIT } from "./proxyInFlightLimit.ts";
import { retryUsage } from "./retryUsage.ts";
import { expireHolds } from "./expireHolds.ts";
import { recordUsage } from "./recordUsage.ts";

export interface HandleAnthropicDeps {
  anthropicBaseUrl: string;
  fetchUpstream: typeof fetch;
  now: () => number;
  /** Deadline for upstream headers and body together; defaults to five minutes. */
  streamTimeoutMs?: number;
  /**
   * Production: ctx.waitUntil from the Worker invocation, keeping the metering
   * write alive after the response stream closes. Tests pass a function that
   * pushes the promise to an array so the assertions can await it.
   */
  waitUntil: (promise: Promise<unknown>) => void;
}

const FORWARDED_HEADERS = new Set(["content-type", "accept", "accept-encoding", "anthropic-version", "anthropic-beta"]);

// Clients need these to back off correctly and to reference upstream errors.
const PASSTHROUGH_RESPONSE_HEADERS = ["retry-after", "x-request-id"];

// Seconds a client waits before retrying a call refused at the in-flight limit.
const IN_FLIGHT_RETRY_AFTER_SECONDS = 10;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECT_HOPS = 5;

type UpstreamResult =
  | { kind: "response"; response: Response }
  | { kind: "cross_origin_redirect"; location: string }
  | { kind: "too_many_redirects"; hops: number };

/**
 * fetch(redirect: "follow") replays the request headers — including the
 * injected x-api-key — to whatever host a Location header names; unlike
 * `authorization`, custom headers are NOT stripped on cross-origin redirects,
 * so a compromised or misconfigured upstream could bounce the proxy to an
 * attacker origin and exfiltrate the real Anthropic key. Follow redirects
 * manually instead: every hop must stay on the configured upstream origin,
 * so the key is only ever sent to that origin. A cross-origin Location is
 * never fetched at all (redirect: "manual" does not follow it).
 */
async function fetchUpstreamSameOrigin(
  fetchUpstream: typeof fetch,
  allowedOrigin: string,
  signal: AbortSignal,
  initial: { url: string; method: string; headers: Headers; body: ArrayBuffer | undefined },
): Promise<UpstreamResult> {
  let { url, method, body } = initial;
  const headers = initial.headers;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    signal.throwIfAborted();
    const response = await fetchUpstream(url, { method, headers, body, redirect: "manual", signal });
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || !location) {
      return { kind: "response", response };
    }
    void response.body?.cancel().catch(() => undefined);
    const next = new URL(location, url);
    if (next.origin !== allowedOrigin) {
      return { kind: "cross_origin_redirect", location: next.origin };
    }
    // Mirror fetch redirect semantics: 303 always re-issues as a bodyless GET,
    // as do 301/302 on POST; 307/308 replay the method and body unchanged.
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
      headers.delete("content-type");
    }
    url = next.toString();
  }
  return { kind: "too_many_redirects", hops: MAX_REDIRECT_HOPS };
}

function pickForwardHeaders(source: Headers): Headers {
  const out = new Headers();
  for (const [k, v] of source.entries()) {
    if (FORWARDED_HEADERS.has(k.toLowerCase())) out.set(k, v);
  }
  return out;
}

/**
 * /anthropic/v1/messages — auth, forward to api.anthropic.com with the real
 * key, stream the response back unmodified, metering usage in a single pass. Only
 * the methods and paths in {@link anthropicEndpointAllowed} are forwarded: the
 * proxy is not a general egress, and the shared key it injects reaches every
 * object in the upstream workspace.
 */
export async function handleAnthropic(
  request: Request,
  env: ReviewWorkerEnv,
  deps: HandleAnthropicDeps,
  url: URL,
): Promise<Response> {
  const proxiedPath = url.pathname.slice("/anthropic".length);
  if (!anthropicEndpointAllowed(request.method, proxiedPath)) {
    return jsonError(404, "endpoint not forwarded; the proxy serves POST /v1/messages only", {
      method: request.method,
      path: proxiedPath,
    });
  }
  const now = deps.now();
  const auth = await authenticateProxyRequest(request, env, now);
  if (!auth) return jsonError(401, "unauthorized");

  let repo: string;
  let pr: number;
  let sessionHash: string | null = null;
  let spendCapUsd = Number.POSITIVE_INFINITY;
  let spentUsd = 0;
  let repoCapUsd: number | null = null;
  if (auth.kind === "session") {
    repo = auth.repo;
    pr = auth.pr;
    sessionHash = auth.hash;
    spendCapUsd = auth.spendCapUsd;
    // Early errors are diagnostic; reserveUsage below serializes admission.
    const fresh = await env.DB.prepare("SELECT spent_usd FROM sessions WHERE hash = ?")
      .bind(auth.hash)
      .first<{ spent_usd: number }>();
    spentUsd = fresh?.spent_usd ?? auth.spentUsd;
    if (spentUsd >= spendCapUsd) {
      return jsonError(402, "session spend cap exhausted", { spendCapUsd, spentUsd });
    }
    // The per-session cap above resets whenever a session is re-minted; the
    // per-repo month-to-date total does not. Enforce it so re-minted sessions
    // cannot drive unbounded spend on an already-reviewed PR. Skipped when the
    // repo has no live registration for a legacy or OIDC session. Sessions
    // issued by an API key still require the same registered repo as the key.
    const registration = await lookupRepo(env.DB, repo);
    if (!registration && auth.apiKey) return jsonError(403, "repo not registered", { repo });
    if (registration) {
      const budget = await assertRepoUnderMonthlyCap(env.DB, registration, repo, now);
      if (budget instanceof Response) return budget;
      repoCapUsd = Math.min(budget.monthlyCapUsd, auth.apiKey?.spendCapUsd ?? budget.monthlyCapUsd);
      if (auth.apiKey?.spendCapUsd != null && budget.monthSpendUsd >= auth.apiKey.spendCapUsd) {
        return jsonError(402, "api key spend cap exhausted", {
          repo,
          keyCapUsd: auth.apiKey.spendCapUsd,
          spentUsd: budget.monthSpendUsd,
        });
      }
    }
  } else {
    const repoHint = request.headers.get("x-smithers-repo");
    // A key with no authorized repos cannot resolve to a repo at all. Honoring
    // an x-smithers-repo hint here would let such a key meter spend against ANY
    // repo's monthly budget (cross-tenant spend / DoS); falling back to
    // auth.owner would instead 403 forever on "repo not registered" (owner is
    // not a repo). Reject up front with an actionable message either way.
    if (auth.repos.length === 0) {
      return jsonError(403, "api key is not scoped to any repo; mint a repo-scoped key", {
        repo: repoHint ?? null,
      });
    }
    if (repoHint) {
      if (!auth.repos.includes(repoHint)) {
        return jsonError(403, "api key not authorized for repo", { repo: repoHint });
      }
      repo = repoHint;
    } else {
      repo = auth.repos[0];
    }
    pr = 0;

    const registration = await lookupRepo(env.DB, repo);
    if (!registration) {
      return jsonError(403, "repo not registered", { repo });
    }
    const budget = await assertRepoUnderMonthlyCap(env.DB, registration, repo, now);
    if (budget instanceof Response) return budget;
    const { monthlyCapUsd, monthSpendUsd } = budget;
    repoCapUsd = Math.min(monthlyCapUsd, auth.spendCapUsd ?? monthlyCapUsd);
    if (auth.spendCapUsd != null && monthSpendUsd >= auth.spendCapUsd) {
      return jsonError(402, "api key spend cap exhausted", {
        repo,
        keyCapUsd: auth.spendCapUsd,
        spentUsd: monthSpendUsd,
      });
    }
  }

  const upstreamUrl = `${deps.anthropicBaseUrl.replace(/\/$/, "")}${proxiedPath}${url.search}`;
  const upstreamHeaders = pickForwardHeaders(request.headers);
  upstreamHeaders.set("x-api-key", env.ANTHROPIC_API_KEY);
  upstreamHeaders.set("anthropic-version", upstreamHeaders.get("anthropic-version") ?? "2023-06-01");

  let priced: Awaited<ReturnType<typeof priceRequest>>;
  try {
    priced = await priceRequest(request);
  } catch (err) {
    return jsonError(400, "request has no bounded price", { detail: String(err) });
  }
  const requestId = randomTokenHex(16);
  try {
    await retryUsage(env.DB, repo);
    await expireHolds(env.DB, repo, now);
    const reservation = await reserveUsage(env.DB, {
      requestId,
      repo,
      sessionHash,
      model: priced.model,
      repoCapUsd,
      costUsd: priced.costUsd,
      now,
    });
    if (reservation === "in_flight_limit") {
      // The window reopens when an outstanding call settles, so this is a rate
      // limit the client parks on; a 402 would end the call for good.
      const refusal = jsonError(429, "in-flight limit reached", { repo, inFlightLimit: PROXY_IN_FLIGHT_LIMIT });
      refusal.headers.set("retry-after", String(IN_FLIGHT_RETRY_AFTER_SECONDS));
      return refusal;
    }
    if (reservation === "spend_cap") {
      return jsonError(402, "spend cap prevents reservation", { repo, reservedCostUsd: priced.costUsd });
    }
  } catch (err) {
    return jsonError(503, "budget admission unavailable", { detail: String(err) });
  }

  const abort = new AbortController();
  const onAbort = () => abort.abort(request.signal.reason);
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  const deadline = setTimeout(
    () => abort.abort(new DOMException("upstream stream deadline exceeded", "TimeoutError")),
    deps.streamTimeoutMs ?? 5 * 60_000,
  );
  const cleanup = () => {
    clearTimeout(deadline);
    request.signal.removeEventListener("abort", onAbort);
  };

  let upstream: Response;
  try {
    const result = await fetchUpstreamSameOrigin(
      deps.fetchUpstream,
      new URL(deps.anthropicBaseUrl).origin,
      abort.signal,
      {
        url: upstreamUrl,
        method: request.method,
        headers: upstreamHeaders,
        body: priced.body,
      },
    );
    if (result.kind === "cross_origin_redirect") {
      cleanup();
      // The injected key was NOT sent to (and never will be sent to) the
      // foreign origin; fail closed rather than forward credentials off-origin.
      return jsonError(502, "upstream redirected off the anthropic origin; refusing to forward credentials", {
        location: result.location,
      });
    }
    if (result.kind === "too_many_redirects") {
      cleanup();
      return jsonError(502, "too many upstream redirects", { hops: result.hops });
    }
    upstream = result.response;
  } catch (err) {
    cleanup();
    return jsonError(502, "upstream fetch failed", { detail: String(err) });
  }

  if (!upstream.body) {
    cleanup();
    if (upstream.status >= 400) {
      await env.DB.prepare("DELETE FROM usage_reservations WHERE id = ?").bind(requestId).run();
    }
    const text = await upstream.text();
    const headers = new Headers({
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    });
    for (const h of PASSTHROUGH_RESPONSE_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }
    return new Response(text, { status: upstream.status, headers });
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  const { passthrough, collected } = teeForMetering(upstream, contentType.includes("text/event-stream"), abort);

  const metering = (async () => {
    const { summary, complete } = await collected.finally(cleanup);
    if (!summary) {
      // A definite upstream rejection spends no inference budget. Ambiguous
      // transport/2xx failures keep the hold; never reopen budget blindly.
      if (upstream.status >= 400) {
        await env.DB.prepare("DELETE FROM usage_reservations WHERE id = ?").bind(requestId).run();
      }
      // A 2xx /v1/messages response that yields no usage is a metering MISS
      // (unexpected body shape), not a benign non-content frame — real spend
      // goes unrecorded. Surface it so Workers logs can catch a parser drift.
      if (upstream.status >= 200 && upstream.status < 300 && proxiedPath.startsWith("/v1/messages")) {
        console.error("smithers-review: metering miss (usage parser returned null on a 2xx messages response)", {
          repo,
          pr,
          path: proxiedPath,
          contentType,
        });
      }
      return;
    }
    const responsePrice = modelPrices(summary.model);
    const admittedPrice = modelPrices(priced.model);
    if (
      Object.keys(admittedPrice).some(
        (key) => responsePrice[key as keyof typeof responsePrice] !== admittedPrice[key as keyof typeof admittedPrice],
      )
    ) {
      throw new Error("upstream model price differs from admitted model");
    }
    await recordUsage(env.DB, {
      requestId,
      sessionHash,
      repo,
      pr,
      summary,
      retainReservation: !complete,
      kind: contentType.includes("text/event-stream") ? "messages_stream" : "messages",
      now: deps.now(),
    });
  })().catch((err) => {
    // recordUsage spends real money; a silent failure here is the last
    // unmetered-spend hole. Log (do not rethrow — the response already
    // streamed) so the drop is diagnosable in production.
    console.error("smithers-review: metering failed", {
      requestId,
      repo,
      pr,
      path: proxiedPath,
      status: upstream.status,
      err: String(err),
    });
  });
  deps.waitUntil(metering);

  const responseHeaders = new Headers();
  for (const h of ["content-type", "cache-control", ...PASSTHROUGH_RESPONSE_HEADERS]) {
    const v = upstream.headers.get(h);
    if (v) responseHeaders.set(h, v);
  }
  return new Response(passthrough, { status: upstream.status, headers: responseHeaders });
}
