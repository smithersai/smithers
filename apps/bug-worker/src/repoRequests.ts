import type { BugWorkerEnv } from "./env.ts";
import { forkRepo } from "./repoForks.ts";
import { checkRateLimit, isOperator, readBodyBounded, type BugWorkerDeps } from "./worker.ts";

const prefix = "repo-request:";
const cors = {
  "access-control-allow-origin": "*",
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};
const json = (status: number, body: unknown, headers = cors) => new Response(JSON.stringify(body), { status, headers });
type Repo = { name: string; url: string };
type Ready = { appUrl: string; completedAt: string };
type Leader = { name: string; count: number };
/** One key holds the ranked leaderboard, so listing costs one read plus one readiness read per entry. */
const leaderboardKey = "repo-nominations-top";
const listTop = 20;
/** Browsers reuse a list for this long; KV is eventually consistent over the same window. */
const listCache = { ...cors, "cache-control": "public, max-age=60" };

/** Accept repository roots only; never fetch a user-supplied host. */
export function repoName(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 250) return null;
  const name = value.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\/$/, "").replace(/\.git$/i, "");
  return /^[a-z\d](?:[a-z\d-]{0,38})\/[a-z\d_.-]{1,100}$/i.test(name) && !/[\/]\.{1,2}$/.test(name)
    ? name.toLowerCase() : null;
}

async function hash(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** Single-use confirmation and cancellation tokens; 128 bits, hex encoded. */
function newToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16))).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** Links in transactional email point back at this worker. */
function baseUrl(env: BugWorkerEnv) {
  return (env.PUBLIC_BASE_URL ?? "https://bug.smithers.sh").replace(/\/$/, "");
}
async function read<T>(env: BugWorkerEnv, key: string): Promise<T | null> {
  const value = await env.BUGS.get(key);
  return value === null ? null : JSON.parse(value) as T;
}
/** Persisted readiness must satisfy the publication contract before sending mail. */
function parseReady(value: string): Ready {
  const ready: unknown = JSON.parse(value);
  if (!ready || typeof ready !== "object" || !("appUrl" in ready) || typeof ready.appUrl !== "string"
    || !("completedAt" in ready) || typeof ready.completedAt !== "string" || !Number.isFinite(Date.parse(ready.completedAt))) {
    throw new Error("Invalid readiness record");
  }
  const url = new URL(ready.appUrl);
  if (url.protocol !== "https:" || !["smithers.sh", "app.smithers.sh", "canary.smithers.sh"].includes(url.hostname) || url.username || url.password || url.port) {
    throw new Error("Invalid readiness app URL");
  }
  return { appUrl: ready.appUrl, completedAt: ready.completedAt };
}
/** Distinct nominations recorded for a repository; one accepted POST is one nomination. */
async function nominations(env: BugWorkerEnv, name: string) {
  return Number(await env.BUGS.get(`repo-nominations:${name}`)) || 0;
}
async function publicRepo(env: BugWorkerEnv, repo: Repo, count?: number) {
  const ready = await read<Ready>(env, `repo-ready:${repo.name}`);
  return {
    ...repo,
    status: ready ? "ready" : "smithering",
    appUrl: ready?.appUrl ?? null,
    nominations: count ?? await nominations(env, repo.name),
  };
}
/** Rewrite the leaderboard with one repository's new count; ties break on name. */
async function rank(env: BugWorkerEnv, name: string, count: number) {
  const leaders = (await read<Leader[]>(env, leaderboardKey) ?? []).filter((leader) => leader.name !== name);
  leaders.push({ name, count });
  leaders.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  await env.BUGS.put(leaderboardKey, JSON.stringify(leaders.slice(0, listTop)));
}
/** Repositories ranked by nominations, most nominated first, exact at any catalog size. */
async function mostNominated(env: BugWorkerEnv) {
  const leaders = await read<Leader[]>(env, leaderboardKey) ?? [];
  return Promise.all(leaders.map((leader) => publicRepo(env, { name: leader.name, url: `https://github.com/${leader.name}` }, leader.count)));
}
async function list(env: BugWorkerEnv, keyPrefix: string, cursor?: string, limit = 50) {
  if (!env.BUGS.list) throw new Error("KV listing unavailable");
  return env.BUGS.list({ prefix: keyPrefix, limit, ...(cursor ? { cursor } : {}) });
}

const maxNotificationAttempts = 3;
/** Pending confirmations live for a day; the KV TTL and the stored expiry agree. */
const confirmationTtlMs = 24 * 3_600_000;
/** Confirmation sends per recipient per hour, across all repositories. */
const confirmationsPerRecipientPerHour = 3;
/** One transactional send through the provider seam; returns the error message on failure. */
async function sendMail(env: BugWorkerEnv, deps: BugWorkerDeps, message: { to: string; subject: string; text: string; idempotencyKey: string }): Promise<string | undefined> {
  try {
    const response = await deps.fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json",
        "idempotency-key": message.idempotencyKey,
      },
      body: JSON.stringify({ from: env.NOTIFICATION_FROM, to: [message.to], subject: message.subject, text: message.text }),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? undefined : `Email provider returned HTTP ${response.status}`;
  } catch (cause) { return cause instanceof Error ? cause.message : String(cause); }
}
/**
 * Consent gate: a submitted address becomes a pending confirmation token, never
 * a subscriber. Only the recipient clicking the emailed link creates the
 * deliverable record, so a caller cannot enroll a third party. The per-recipient
 * throttle bounds confirmation mail a victim can be sent; the per-IP submission
 * throttle bounds the sender side.
 */
async function subscribe(env: BugWorkerEnv, deps: BugWorkerDeps, name: string, email: string): Promise<"sent" | "rate_limited" | "send_failed" | "email_not_configured"> {
  if (!env.RESEND_API_KEY || !env.NOTIFICATION_FROM) return "email_not_configured";
  const now = deps.now();
  const throttleKey = `repo-confirm-throttle:${await hash(email)}:${Math.floor(now / 3_600_000)}`;
  const sent = Number(await env.BUGS.get(throttleKey)) || 0;
  if (sent >= confirmationsPerRecipientPerHour) return "rate_limited";
  const confirmToken = newToken();
  const error = await sendMail(env, deps, {
    to: email,
    subject: `Confirm your Smithers notification for ${name}`,
    text: `Someone asked Smithers to email this address once ${name} is smithered and available to everyone.\n\nIf that was you, confirm within 24 hours: ${baseUrl(env)}/api/repo-requests/confirm?token=${confirmToken}\n\nIf it was not you, ignore this email and nothing more will be sent. To cancel the request: ${baseUrl(env)}/api/repo-requests/cancel?token=${confirmToken}`,
    idempotencyKey: `smithers-confirm-${await hash(confirmToken)}`,
  });
  if (error !== undefined) return "send_failed";
  await env.BUGS.put(throttleKey, String(sent + 1), { expirationTtl: 3600 });
  await env.BUGS.put(`repo-confirm:${confirmToken}`, JSON.stringify({ name, email, expiresAt: now + confirmationTtlMs }), { expirationTtl: confirmationTtlMs / 1000 });
  return "sent";
}
const tokenPattern = /^[0-9a-f]{32}$/;
/** Move a pending address into the deliverable set. The token is single-use. */
async function confirmSubscription(env: BugWorkerEnv, deps: BugWorkerDeps, token: string): Promise<Response> {
  if (!tokenPattern.test(token)) return json(400, { error: "A confirmation token is required." });
  const key = `repo-confirm:${token}`;
  const pending = await read<{ name: unknown; email: unknown; expiresAt: unknown }>(env, key);
  if (!pending) return json(410, { error: "This confirmation link is invalid or has already been used." });
  if (typeof pending.name !== "string" || typeof pending.email !== "string" || typeof pending.expiresAt !== "number" || deps.now() > pending.expiresAt) {
    await env.BUGS.delete(key);
    return json(410, { error: "This confirmation link has expired." });
  }
  await env.BUGS.delete(key);
  const cancelToken = newToken();
  const subscriberKey = `repo-subscriber:${pending.name}:${await hash(pending.email)}`;
  await env.BUGS.put(subscriberKey, JSON.stringify({ email: pending.email, cancel: cancelToken }));
  await env.BUGS.put(`repo-cancel:${cancelToken}`, JSON.stringify({ key: subscriberKey }));
  return json(200, { repo: pending.name, subscribed: true, cancel: `${baseUrl(env)}/api/repo-requests/cancel?token=${cancelToken}` });
}
/** Remove a pending confirmation or a confirmed subscription. */
async function cancelSubscription(env: BugWorkerEnv, token: string): Promise<Response> {
  if (!tokenPattern.test(token)) return json(400, { error: "A cancellation token is required." });
  const pendingKey = `repo-confirm:${token}`;
  if (await env.BUGS.get(pendingKey) !== null) {
    await env.BUGS.delete(pendingKey);
    return json(200, { cancelled: true });
  }
  const cancelKey = `repo-cancel:${token}`;
  const cancel = await read<{ key: unknown }>(env, cancelKey);
  if (!cancel || typeof cancel.key !== "string") return json(404, { error: "This cancellation link is invalid or has already been used." });
  await env.BUGS.delete(cancelKey);
  await env.BUGS.delete(cancel.key);
  return json(200, { cancelled: true });
}
/** Bounded delivery, with receipts, a failure budget, and provider deduplication. */
async function notify(env: BugWorkerEnv, deps: BugWorkerDeps, name: string, ready: Ready, cursor?: string) {
  if (!env.RESEND_API_KEY || !env.NOTIFICATION_FROM) return { pending: true, reason: "email_not_configured" };
  const page = await list(env, `repo-subscriber:${name}:`, cursor);
  let sent = 0;
  let failed = 0;
  for (const key of page.keys) {
    try {
      if (await env.BUGS.get(`repo-notified:${key.name}`)) continue;
      const failureKey = `repo-notification-failure:${key.name}`;
      const failure = await read<{ attempts: number }>(env, failureKey);
      if (failure && failure.attempts >= maxNotificationAttempts) continue;
      const stored = await env.BUGS.get(key.name);
      if (!stored) continue;
      // Confirmed subscribers are JSON with a cancellation token; plain
      // addresses predate the confirmation flow and stay deliverable.
      let email = stored;
      let cancel: string | undefined;
      try {
        const parsed: unknown = JSON.parse(stored);
        if (parsed && typeof parsed === "object" && "email" in parsed && typeof parsed.email === "string") {
          email = parsed.email;
          if ("cancel" in parsed && typeof parsed.cancel === "string") cancel = parsed.cancel;
        }
      } catch { /* A plain address is a legacy confirmed subscriber. */ }
      const error = await sendMail(env, deps, {
        to: email,
        subject: `${name} is ready in Smithers`,
        text: `You asked to be notified when ${name} was smithered. It is now supported in Smithers and available to everyone.\n\nOpen in Smithers: ${ready.appUrl}\n\nThis is the one-time notification you requested at smithers.sh.${cancel ? `\n\nUnsubscribe: ${baseUrl(env)}/api/repo-requests/cancel?token=${cancel}` : ""}`,
        idempotencyKey: `smithers-ready-${await hash(key.name)}`,
      });
      if (error === undefined) {
        await env.BUGS.put(`repo-notified:${key.name}`, ready.completedAt);
        sent++;
      } else {
        const attempts = (failure?.attempts ?? 0) + 1;
        await env.BUGS.put(failureKey, JSON.stringify({ attempts, terminal: attempts >= maxNotificationAttempts, failedAt: new Date(deps.now()).toISOString(), error }));
        failed++;
      }
    } catch (error) {
      failed++;
      console.error(`repo-notification ${key.name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { sent, failed, pending: failed > 0 || !page.list_complete, cursor: page.list_complete ? null : page.cursor };
}

export async function handleRepoRequests(request: Request, env: BugWorkerEnv, deps: BugWorkerDeps): Promise<Response> {
  try {
    const url = new URL(request.url);
    const route = url.pathname.slice("/api/repo-requests".length);
    if (request.method === "GET" && route === "") {
      const query = url.searchParams.get("repo");
      if (query === null) return json(200, { repos: await mostNominated(env) }, listCache);
      const name = repoName(query);
      if (!name) return json(400, { error: "Enter a GitHub repository URL or owner/repo." });
      const repo = await read<Repo>(env, `${prefix}${name}`);
      if (!repo) return json(404, { error: "Repository has not been requested." });
      return json(200, { repo: await publicRepo(env, repo) });
    }
    if (request.method === "GET" && route === "/confirm") return confirmSubscription(env, deps, url.searchParams.get("token") ?? "");
    if (request.method === "GET" && route === "/cancel") return cancelSubscription(env, url.searchParams.get("token") ?? "");
    const admin = route === "/complete" || route === "/notify";
    if (request.method !== "POST" || (route !== "" && !admin)) return json(404, { error: "Not found." });
    if (admin && !(await isOperator(request, env))) {
      return json(401, { error: "Admin authentication required." });
    }
    if (!admin && !(await checkRateLimit(env, `repos:${request.headers.get("cf-connecting-ip") ?? "unknown"}`, deps.now()))) {
      return json(429, { error: "Too many requests. Please try again later." });
    }
    const raw = await readBodyBounded(request, 4096);
    if (raw === null) return json(413, { error: "Request is too large." });
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    } catch { return json(400, { error: "Send a JSON object." }); }
    const name = repoName(body.repo);
    if (!name) return json(400, { error: "Enter a GitHub repository URL or owner/repo." });
    let repo = await read<Repo>(env, `${prefix}${name}`);
    if (admin) {
      if (!repo) return json(404, { error: "Repository has not been requested." });
      let ready = await read<Ready>(env, `repo-ready:${name}`);
      if (route === "/complete") {
        let appUrl: URL;
        try { appUrl = new URL(String(body.appUrl)); } catch { return json(400, { error: "A public Smithers app URL is required." }); }
        if (appUrl.protocol !== "https:" || !["smithers.sh", "app.smithers.sh", "canary.smithers.sh"].includes(appUrl.hostname) || appUrl.username || appUrl.password || appUrl.port) {
          return json(400, { error: "Use an HTTPS URL on a Smithers app domain." });
        }
        if (!env.REPO_COMPLETIONS) return json(503, { error: "Repository completion is unavailable." });
        const committed = await env.REPO_COMPLETIONS.getByName(name).fetch(new Request("https://repo-completion/", {
          method: "POST",
          body: JSON.stringify({ name, candidate: { appUrl: appUrl.href, completedAt: new Date(deps.now()).toISOString() } }),
        }));
        if (!committed.ok) throw new Error("Repository completion failed");
        const winner = await committed.json() as Ready;
        if (winner.appUrl !== appUrl.href) return json(409, { error: "This repository already has a published app URL." });
        // Mirror only the durable winner for public reads and scheduled delivery.
        // A failed mirror is repaired by retrying the same completion.
        if (!ready || ready.appUrl !== winner.appUrl || ready.completedAt !== winner.completedAt) {
          await env.BUGS.put(`repo-ready:${name}`, JSON.stringify(winner));
        }
        ready = winner;
      }
      if (!ready) return json(409, { error: "Repository is still smithering." });
      // Publishing and delivery are separate: notification failure cannot undo readiness.
      return json(200, { repo: { ...repo, status: "ready", appUrl: ready.appUrl }, notifications: await notify(env, deps, name, ready, typeof body.cursor === "string" ? body.cursor : undefined) });
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if ((body.email !== undefined && typeof body.email !== "string") || (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))) {
      return json(400, { error: "Enter a valid email address or leave it blank." });
    }
    if (!repo) {
      let response: Response;
      try {
        response = await deps.fetch(`https://api.github.com/repos/${name}`, {
          headers: { accept: "application/vnd.github+json", "user-agent": "Smithers-repo-requests" },
          signal: AbortSignal.timeout(10_000), redirect: "manual",
        });
      } catch { return json(503, { error: "Could not check GitHub. Please try again." }); }
      // workerd refuses redirect: "error" (it throws before the request is sent, so every
      // new nomination failed with 503 in production while Bun accepted the option locally).
      // The redirect is requested manually and a 3xx answer means the repository has moved,
      // which gets the same honest refusal as a 404.
      if (response.status === 404 || (response.status >= 300 && response.status < 400)) {
        return json(400, { error: "That repository was not found. Please use a public GitHub repository." });
      }
      if (!response.ok) return json(503, { error: "GitHub is unavailable or rate limited. Please try again later." });
      const github = await response.json() as { private?: boolean; disabled?: boolean; license?: { spdx_id?: string } };
      if (github.private !== false || github.disabled || !github.license?.spdx_id || github.license.spdx_id === "NOASSERTION") {
        return json(400, { error: "Please use a public repository with a recognized open-source license." });
      }
      // Immutable metadata and separate readiness keys prevent concurrent submissions
      // from resetting completed work. Each subscriber also has an independent key.
      repo = { name, url: `https://github.com/${name}` };
      await env.BUGS.put(`${prefix}${name}`, JSON.stringify(repo));
      await forkRepo(env, deps, name);
    }
    // A plain counter per repository: KV has no atomic increment, so two simultaneous
    // nominations can record one. That undercount is acceptable for a public tally,
    // and the leaderboard rewritten beside the counter shares the same trade-off.
    const count = await nominations(env, name) + 1;
    await env.BUGS.put(`repo-nominations:${name}`, String(count));
    await rank(env, name, count);
    const result = await publicRepo(env, repo, count);
    // Consent first: the address stays a pending token, and `subscribed` only
    // means the confirmation email left; delivery starts after the recipient
    // confirms. Without provider configuration no consent email can be sent,
    // so nothing is stored.
    let subscribed = false;
    let confirmation: string | undefined;
    if (email && result.status !== "ready") {
      const outcome = await subscribe(env, deps, name, email);
      if (outcome === "sent") subscribed = true;
      else confirmation = outcome;
    }
    return json(200, { repo: result, subscribed, ...(confirmation ? { confirmation } : {}) });
  } catch {
    return json(503, { error: "Repository requests are temporarily unavailable. Please try again." });
  }
}

/** Re-scan completed repositories so late signups and failed sends are retried. */
export async function retryRepoNotifications(env: BugWorkerEnv, deps: BugWorkerDeps): Promise<void> {
  if (!env.RESEND_API_KEY || !env.NOTIFICATION_FROM) return;
  // A cursor bounds each invocation; repeated scheduled runs visit every repo.
  const cursor = await env.BUGS.get("repo-notification-sweep") || undefined;
  const page = await list(env, "repo-ready:", cursor, 2);
  for (const key of page.keys) {
    try {
      const value = await env.BUGS.get(key.name);
      if (value === null) continue;
      const ready = parseReady(value);
      const name = key.name.slice("repo-ready:".length);
      const cursorKey = `repo-notification-cursor:${name}`;
      const result = await notify(env, deps, name, ready, await env.BUGS.get(cursorKey) || undefined);
      // Failed recipients are revisited after the scan wraps, never by pinning a page.
      if ("cursor" in result) await env.BUGS.put(cursorKey, result.cursor || "");
    } catch (error) {
      console.error(`repo-notification ${key.name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await env.BUGS.put("repo-notification-sweep", page.list_complete ? "" : page.cursor || "");
}
