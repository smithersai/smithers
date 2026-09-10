import { describe, expect, spyOn, test } from "bun:test";
import { createBugWorker } from "../src/worker.ts";
import { repoName } from "../src/repoRequests.ts";
import { memoryKv } from "./helpers/memoryKv.ts";
import { memoryRepoCompletions } from "./helpers/memoryRepoCompletions.ts";
import type { BugWorkerEnv } from "../src/env.ts";

function fixture() {
  const env: BugWorkerEnv = { BUGS: memoryKv(), BUG_ADMIN_TOKEN: "test-admin", RESEND_API_KEY: "test-key", NOTIFICATION_FROM: "Smithers <test@example.com>" };
  env.REPO_COMPLETIONS = memoryRepoCompletions(env);
  const calls: { url: string; init?: RequestInit }[] = [];
  let now = 1788500000000;
  let emailStatus = 200;
  let recipientStatus: ((email: string) => number) | undefined;
  let github: unknown = { private: false, license: { spdx_id: "MIT" } };
  let githubStatus = 200;
  const worker = createBugWorker({ now: () => now, fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("api.github.com")) return Response.json(github, { status: githubStatus });
    return Response.json({ id: "email-1" }, { status: url.includes("resend") ? recipientStatus?.(JSON.parse(String(init?.body)).to[0]) ?? emailStatus : 200 });
  }) as typeof fetch });
  const call = (body?: unknown, route = "", admin = false, ip = "203.0.113.1") => worker.fetch(new Request(`https://bug.smithers.sh/api/repo-requests${route}`, {
    method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...(admin ? { "x-bug-admin": "test-admin" } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  const complete = () => call({ repo: "owner/repo", appUrl: "https://app.smithers.sh/repos/owner/repo" }, "/complete", true);
  const mails = (subject: string) => calls.filter((call) => call.url.includes("resend"))
    .map((call) => JSON.parse(String(call.init?.body)) as { to: string[]; subject: string; text: string })
    .filter((mail) => mail.subject.includes(subject));
  const confirmTokenFor = (to: string) => /confirm\?token=([0-9a-f]{32})/.exec(mails("Confirm your Smithers notification").find((mail) => mail.to[0] === to)!.text)![1]!;
  const confirm = (to: string) => call(undefined, `/confirm?token=${confirmTokenFor(to)}`);
  return { env, worker, calls, call, complete, mails, confirm, confirmTokenFor, setNow: (value: number) => { now = value; }, recipientStatus: (value: (email: string) => number) => { recipientStatus = value; }, emailStatus: (value: number) => { emailStatus = value; }, github: (value: unknown, status = 200) => { github = value; githubStatus = status; } };
}

describe("public repository requests", () => {
  test("normalizes roots and rejects foreign hosts, paths, credentials, and invalid names", () => {
    expect(repoName(" https://github.com/Owner/Repo.git/ ")).toBe("owner/repo");
    for (const value of ["https://evil.com/owner/repo", "https://github.com/owner/repo/tree/main", "https://github.com@evil.com/a/b", "owner/..", "owner/repo?x=1", null]) expect(repoName(value)).toBeNull();
  });
  test("persists smithering, deduplicates repo and emails, and keeps email private", async () => {
    const f = fixture();
    const response = await f.call({ repo: "https://github.com/Owner/Repo", email: "Me@example.com" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ repo: { name: "owner/repo", status: "smithering", appUrl: null }, subscribed: true });
    await f.call({ repo: "owner/repo.git", email: "me@example.com" });
    expect(f.calls.filter((call) => call.url.includes("api.github.com"))).toHaveLength(1);
    const listing = await (await f.call()).text();
    expect(listing).toContain('"smithering"');
    expect(listing).not.toContain("example.com");
    // Nothing is deliverable until the recipient confirms; submissions hold pending tokens only.
    expect((await f.env.BUGS.list!({ prefix: "repo-subscriber:" })).keys).toHaveLength(0);
    expect((await f.env.BUGS.list!({ prefix: "repo-confirm:" })).keys).toHaveLength(2);
    expect(f.mails("Confirm your Smithers notification").map((mail) => mail.to[0])).toEqual(["me@example.com", "me@example.com"]);
    expect((await f.confirm("me@example.com")).status).toBe(200);
    expect((await f.env.BUGS.list!({ prefix: "repo-subscriber:" })).keys).toHaveLength(1);
  });
  test("validates email before creating requests and rejects private or unlicensed repos", async () => {
    const f = fixture();
    expect((await f.call({ repo: "owner/repo", email: "oops" })).status).toBe(400);
    expect(f.calls).toHaveLength(0);
    for (const github of [{ private: true, license: { spdx_id: "MIT" } }, { private: false }, { private: false, license: { spdx_id: "NOASSERTION" } }]) {
      f.github(github);
      expect((await f.call({ repo: "owner/repo" })).status).toBe(400);
    }
    expect((await f.env.BUGS.list!({ prefix: "repo-request:" })).keys).toHaveLength(0);
  });
  test("checks GitHub with a manual redirect and refuses a moved repository like a missing one", async () => {
    // workerd rejects redirect: "error" before sending, so the check must ask for "manual"
    // and read a 3xx answer itself; "follow" would land on the renamed repository instead.
    const f = fixture();
    f.github({ message: "Moved Permanently" }, 301);
    const moved = await f.call({ repo: "owner/moved" });
    expect(moved.status).toBe(400);
    expect(await moved.json()).toEqual({ error: "That repository was not found. Please use a public GitHub repository." });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://api.github.com/repos/owner/moved");
    expect(f.calls[0]!.init?.redirect).toBe("manual");
    f.github({ message: "Not Found" }, 404);
    const missing = await f.call({ repo: "owner/missing" });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "That repository was not found. Please use a public GitHub repository." });
    expect((await f.env.BUGS.list!({ prefix: "repo-request:" })).keys).toHaveLength(0);
    expect((await f.env.BUGS.list!({ prefix: "repo-nominations:" })).keys).toHaveLength(0);
    f.github({ private: false, license: { spdx_id: "MIT" } }, 200);
    expect((await f.call({ repo: "owner/repo" })).status).toBe(200);
    expect((await f.env.BUGS.list!({ prefix: "repo-request:" })).keys).toHaveLength(1);
  });
  test("completion requires authentication and an allowed public app URL", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo" });
    expect((await f.call({ repo: "owner/repo" }, "/complete")).status).toBe(401);
    for (const appUrl of ["javascript:alert(1)", "https://evil.com", "https://user@app.smithers.sh", "http://app.smithers.sh"]) {
      expect((await f.call({ repo: "owner/repo", appUrl }, "/complete", true)).status).toBe(400);
    }
    expect((await f.complete()).status).toBe(200);
    expect(await (await f.call()).json()).toMatchObject({ repos: [{ status: "ready", appUrl: "https://app.smithers.sh/repos/owner/repo" }] });
    expect(await (await f.call({ repo: "owner/repo", email: "later@example.com" })).json()).toMatchObject({ repo: { status: "ready" }, subscribed: false });
  });
  test("concurrent conflicting completions publish and notify only the winning URL", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo", email: "one@example.com" });
    expect((await f.confirm("one@example.com")).status).toBe(200);
    const get = f.env.BUGS.get.bind(f.env.BUGS);
    let arrivals = 0;
    let release!: () => void;
    const both = new Promise<void>((resolve) => { release = resolve; });
    // Hold both null readiness reads so neither request can publish first.
    f.env.BUGS.get = async (key) => {
      const value = await get(key);
      if (key === "repo-ready:owner/repo" && arrivals < 2) {
        if (++arrivals === 2) release();
        await both;
      }
      return value;
    };
    const responses = await Promise.all(["first", "second"].map((path) =>
      f.call({ repo: "owner/repo", appUrl: `https://app.smithers.sh/${path}` }, "/complete", true)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = await responses.find((response) => response.status === 200)!.json();
    const ready = JSON.parse((await get("repo-ready:owner/repo"))!);
    expect(ready.appUrl).toBe(winner.repo.appUrl);
    const emails = f.mails("is ready in Smithers");
    expect(emails).toHaveLength(1);
    expect(emails[0]!.text).toContain(winner.repo.appUrl);
    expect((await f.call({ repo: "owner/repo", appUrl: winner.repo.appUrl }, "/complete", true)).status).toBe(200);
    expect(JSON.parse((await get("repo-ready:owner/repo"))!)).toEqual(ready);
  });
  test("completion preserves URLs published before the durable coordinator was introduced", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo" });
    const ready = { appUrl: "https://app.smithers.sh/legacy", completedAt: "2026-01-01T00:00:00.000Z" };
    await f.env.BUGS.put("repo-ready:owner/repo", JSON.stringify(ready));
    expect((await f.complete()).status).toBe(409);
    expect((await f.call({ repo: "owner/repo", appUrl: ready.appUrl }, "/complete", true)).status).toBe(200);
    expect(JSON.parse((await f.env.BUGS.get("repo-ready:owner/repo"))!)).toEqual(ready);
  });
  test("a failed readiness mirror cannot let a retry publish a different URL", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo", email: "one@example.com" });
    expect((await f.confirm("one@example.com")).status).toBe(200);
    const put = f.env.BUGS.put.bind(f.env.BUGS);
    f.env.BUGS.put = async (key, value, options) => {
      if (key.startsWith("repo-ready:")) throw new Error("KV unavailable");
      return put(key, value, options);
    };
    expect((await f.complete()).status).toBe(503);
    expect(f.mails("is ready in Smithers")).toHaveLength(0);
    f.env.BUGS.put = put;
    expect((await f.call({ repo: "owner/repo", appUrl: "https://app.smithers.sh/other" }, "/complete", true)).status).toBe(409);
    expect((await f.complete()).status).toBe(200);
    expect(JSON.parse((await f.env.BUGS.get("repo-ready:owner/repo"))!).appUrl).toBe("https://app.smithers.sh/repos/owner/repo");
    expect(f.mails("is ready in Smithers")).toHaveLength(1);
  });
  test("stale KV readiness cannot overwrite the durable publication", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo" });
    expect((await f.complete()).status).toBe(200);
    const get = f.env.BUGS.get.bind(f.env.BUGS);
    const original = await get("repo-ready:owner/repo");
    f.env.BUGS.get = (key) => key === "repo-ready:owner/repo" ? Promise.resolve(null) : get(key);
    expect((await f.call({ repo: "OWNER/REPO", appUrl: "https://app.smithers.sh/other" }, "/complete", true)).status).toBe(409);
    expect((await f.complete()).status).toBe(200);
    expect(await get("repo-ready:owner/repo")).toBe(original);
    await f.call({ repo: "owner/another" });
    expect((await f.call({ repo: "owner/another", appUrl: "https://app.smithers.sh/another" }, "/complete", true)).status).toBe(200);
  });
  test("completion fails closed without the durable binding", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo", email: "one@example.com" });
    delete f.env.REPO_COMPLETIONS;
    expect((await f.complete()).status).toBe(503);
    expect(await f.env.BUGS.get("repo-ready:owner/repo")).toBeNull();
    expect(f.mails("is ready in Smithers")).toHaveLength(0);
  });
  test("notifies all subscribers once and retries failures without rolling back readiness", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo", email: "one@example.com" });
    await f.call({ repo: "owner/repo", email: "two@example.com" });
    await f.confirm("one@example.com");
    await f.confirm("two@example.com");
    f.emailStatus(500);
    const result = await (await f.complete()).json();
    expect(result).toMatchObject({ repo: { status: "ready" }, notifications: { failed: 2, pending: true } });
    f.emailStatus(200);
    await f.worker.scheduled({}, f.env);
    const emails = f.calls.filter((call) => call.url.includes("resend") && String(call.init?.body).includes("is ready in Smithers"));
    expect(emails).toHaveLength(4);
    expect(emails[0]!.init!.headers).toEqual(emails[2]!.init!.headers);
    await f.complete();
    expect(f.calls.filter((call) => call.url.includes("resend") && String(call.init?.body).includes("is ready in Smithers"))).toHaveLength(4);
  });
  test("a permanent rejection cannot starve later pages and reaches terminal state", async () => {
    const f = fixture();
    const ready = { appUrl: "https://app.smithers.sh/repos/owner/repo", completedAt: "2026-01-01T00:00:00.000Z" };
    await f.env.BUGS.put("repo-ready:owner/repo", JSON.stringify(ready));
    for (let i = 0; i < 51; i++) {
      await f.env.BUGS.put(`repo-subscriber:owner/repo:${String(i).padStart(3, "0")}`, `user${i}@example.com`);
    }
    f.recipientStatus((email) => email === "user0@example.com" ? 422 : 200);
    await f.worker.scheduled({}, f.env);
    expect(await f.env.BUGS.get("repo-notification-cursor:owner/repo")).toBe("50");
    await f.worker.scheduled({}, f.env);
    expect(await f.env.BUGS.get("repo-notified:repo-subscriber:owner/repo:050")).toBe(ready.completedAt);
    expect(await f.env.BUGS.get("repo-notification-cursor:owner/repo")).toBe("");
    for (let i = 0; i < 6; i++) await f.worker.scheduled({}, f.env);
    const emails = f.calls.filter((call) => call.url.includes("resend"));
    expect(emails).toHaveLength(53);
    expect(emails.filter((call) => JSON.parse(String(call.init?.body)).to[0] === "user0@example.com")).toHaveLength(3);
    expect((await f.env.BUGS.list!({ prefix: "repo-notified:" })).keys).toHaveLength(50);
    expect(JSON.parse((await f.env.BUGS.get("repo-notification-failure:repo-subscriber:owner/repo:000"))!)).toMatchObject({ attempts: 3, terminal: true });
  });
  test("a transient failure is retried on the next sweep and receipted", async () => {
    const f = fixture();
    await f.env.BUGS.put("repo-ready:owner/repo", JSON.stringify({ appUrl: "https://app.smithers.sh/repo", completedAt: "2026-01-01T00:00:00.000Z" }));
    await f.env.BUGS.put("repo-subscriber:owner/repo:one", "one@example.com");
    f.emailStatus(500);
    await f.worker.scheduled({}, f.env);
    expect(await f.env.BUGS.get("repo-notification-cursor:owner/repo")).toBe("");
    expect(await f.env.BUGS.get("repo-notified:repo-subscriber:owner/repo:one")).toBeNull();
    f.emailStatus(200);
    await f.worker.scheduled({}, f.env);
    await f.worker.scheduled({}, f.env);
    expect(f.calls.filter((call) => call.url.includes("resend"))).toHaveLength(2);
    expect(await f.env.BUGS.get("repo-notified:repo-subscriber:owner/repo:one")).toBe("2026-01-01T00:00:00.000Z");
  });
  test.each(["{", "null", "[]", "{}", '{"appUrl":7,"completedAt":true}', '{"appUrl":"https://evil.com","completedAt":"2026-01-01"}', '{"appUrl":"https://app.smithers.sh/repo","completedAt":"invalid"}'])("skips and logs corrupt readiness %s while advancing the sweep", async (corrupt) => {
    const f = fixture();
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const ready = JSON.stringify({ appUrl: "https://app.smithers.sh/repo", completedAt: "2026-01-01T00:00:00.000Z" });
      await f.env.BUGS.put("repo-ready:a/bad", corrupt);
      await f.env.BUGS.put("repo-subscriber:a/bad:one", "bad@example.com");
      for (const name of ["b/good", "z/good"]) {
        await f.env.BUGS.put(`repo-ready:${name}`, ready);
        await f.env.BUGS.put(`repo-subscriber:${name}:one`, `${name[0]}@example.com`);
      }
      await f.worker.scheduled({}, f.env);
      expect(log).toHaveBeenCalled();
      expect(log.mock.calls.some((args) => String(args[0]).includes("repo-ready:a/bad"))).toBe(true);
      expect(await f.env.BUGS.get("repo-notified:repo-subscriber:b/good:one")).not.toBeNull();
      expect(await f.env.BUGS.get("repo-notification-sweep")).toBe("2");
      await f.worker.scheduled({}, f.env);
      expect(await f.env.BUGS.get("repo-notified:repo-subscriber:z/good:one")).not.toBeNull();
      expect(await f.env.BUGS.get("repo-notification-sweep")).toBe("");
      expect(f.calls.filter((call) => call.url.includes("resend"))).toHaveLength(2);
    } finally { log.mockRestore(); }
  });
  test.each(["readiness", "subscriber", "cursor"])("isolates a %s KV failure and retries after recovery", async (site) => {
    const f = fixture();
    const log = spyOn(console, "error").mockImplementation(() => {});
    const get = f.env.BUGS.get.bind(f.env.BUGS);
    const put = f.env.BUGS.put.bind(f.env.BUGS);
    try {
      for (const name of ["a/bad", "b/good", "z/good"]) {
        await put(`repo-ready:${name}`, JSON.stringify({ appUrl: "https://app.smithers.sh/repo", completedAt: "2026-01-01T00:00:00.000Z" }));
        await put(`repo-subscriber:${name}:one`, `${name[0]}@example.com`);
      }
      f.env.BUGS.get = async (key) => {
        if (key === (site === "readiness" ? "repo-ready:a/bad" : site === "subscriber" ? "repo-subscriber:a/bad:one" : "")) throw new Error("KV offline");
        return get(key);
      };
      f.env.BUGS.put = async (key, value, options) => {
        if (site === "cursor" && key === "repo-notification-cursor:a/bad") throw new Error("KV offline");
        return put(key, value, options);
      };
      await f.worker.scheduled({}, f.env);
      expect(log.mock.calls.some((args) => String(args[0]).includes("a/bad"))).toBe(true);
      expect(await get("repo-notified:repo-subscriber:b/good:one")).not.toBeNull();
      expect(await get("repo-notification-sweep")).toBe("2");
      f.env.BUGS.get = get;
      f.env.BUGS.put = put;
      await f.worker.scheduled({}, f.env);
      await f.worker.scheduled({}, f.env);
      expect(await get("repo-notified:repo-subscriber:a/bad:one")).not.toBeNull();
      expect(await get("repo-notified:repo-subscriber:z/good:one")).not.toBeNull();
      expect(f.calls.filter((call) => call.url.includes("resend"))).toHaveLength(3);
    } finally { log.mockRestore(); }
  });
  test("without email configuration no consent can be obtained and nothing is delivered", async () => {
    const f = fixture();
    delete f.env.RESEND_API_KEY;
    const submitted = await f.call({ repo: "owner/repo", email: "one@example.com" });
    expect(await submitted.json()).toMatchObject({ subscribed: false, confirmation: "email_not_configured" });
    expect((await f.env.BUGS.list!({ prefix: "repo-confirm:" })).keys).toHaveLength(0);
    expect(await (await f.complete()).json()).toMatchObject({ notifications: { pending: true, reason: "email_not_configured" } });
    // Configuring the provider later cannot mail the unconfirmed address; the sweep skips it.
    f.env.RESEND_API_KEY = "test-key";
    await f.worker.scheduled({}, f.env);
    expect(f.mails("is ready in Smithers")).toHaveLength(0);
    // A fresh subscribe-confirm-complete round on another repo delivers normally.
    await f.call({ repo: "owner/other", email: "one@example.com" });
    expect((await f.confirm("one@example.com")).status).toBe(200);
    await f.call({ repo: "owner/other", appUrl: "https://app.smithers.sh/other" }, "/complete", true);
    expect(f.mails("is ready in Smithers")).toHaveLength(1);
  });
  test("scheduled sweep picks up signups arriving after completion", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo" });
    await f.complete();
    await f.env.BUGS.put("repo-subscriber:owner/repo:late-signup", "late@example.com");
    await f.worker.scheduled({}, f.env);
    expect(f.calls.filter((call) => call.url.includes("resend"))).toHaveLength(1);
  });
  test("delivers to an address only after the recipient confirms", async () => {
    const f = fixture();
    const submitted = await f.call({ repo: "owner/repo", email: "fan@example.com" });
    expect(await submitted.json()).toMatchObject({ subscribed: true });
    // A submission creates one pending token and one confirmation email, never a subscriber.
    expect((await f.env.BUGS.list!({ prefix: "repo-subscriber:" })).keys).toHaveLength(0);
    expect((await f.env.BUGS.list!({ prefix: "repo-confirm:" })).keys).toHaveLength(1);
    const confirmation = f.mails("Confirm your Smithers notification for owner/repo");
    expect(confirmation).toHaveLength(1);
    expect(confirmation[0]!.to).toEqual(["fan@example.com"]);
    expect(confirmation[0]!.text).toContain("cancel?token=");
    // Completion and the scheduled sweep both skip the unconfirmed address.
    await f.complete();
    await f.worker.scheduled({}, f.env);
    expect(f.mails("is ready in Smithers")).toHaveLength(0);
    const confirmed = await f.confirm("fan@example.com");
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ repo: "owner/repo", subscribed: true });
    expect((await f.env.BUGS.list!({ prefix: "repo-subscriber:" })).keys).toHaveLength(1);
    await f.worker.scheduled({}, f.env);
    const ready = f.mails("is ready in Smithers");
    expect(ready).toHaveLength(1);
    expect(ready[0]!.to).toEqual(["fan@example.com"]);
    expect(ready[0]!.text).toContain("Unsubscribe: https://bug.smithers.sh/api/repo-requests/cancel?token=");
  });
  test("confirmation tokens are validated, single-use, and expire after 24 hours", async () => {
    const f = fixture();
    await f.call({ repo: "owner/repo", email: "fan@example.com" });
    const token = f.confirmTokenFor("fan@example.com");
    expect((await f.call(undefined, "/confirm?token=oops")).status).toBe(400);
    expect((await f.call(undefined, `/confirm?token=${"0".repeat(32)}`)).status).toBe(410);
    expect((await f.confirm("fan@example.com")).status).toBe(200);
    expect((await f.call(undefined, `/confirm?token=${token}`)).status).toBe(410);
    await f.call({ repo: "owner/repo", email: "late@example.com" });
    const lateToken = f.confirmTokenFor("late@example.com");
    f.setNow(1788500000000 + 25 * 3_600_000);
    const expired = await f.call(undefined, `/confirm?token=${lateToken}`);
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ error: "This confirmation link has expired." });
    expect((await f.env.BUGS.list!({ prefix: "repo-confirm:" })).keys).toHaveLength(0);
    expect((await f.env.BUGS.list!({ prefix: "repo-subscriber:" })).keys).toHaveLength(1);
  });
  test("cancellation removes pending and confirmed subscriptions", async () => {
    const f = fixture();
    // Pending: the cancel link in the confirmation email kills the token before any delivery.
    await f.call({ repo: "owner/repo", email: "pending@example.com" });
    const pendingToken = /cancel\?token=([0-9a-f]{32})/.exec(f.mails("Confirm your Smithers notification").find((mail) => mail.to[0] === "pending@example.com")!.text)![1]!;
    expect(await (await f.call(undefined, `/cancel?token=${pendingToken}`)).json()).toEqual({ cancelled: true });
    expect((await f.call(undefined, `/confirm?token=${pendingToken}`)).status).toBe(410);
    await f.complete();
    await f.worker.scheduled({}, f.env);
    expect(f.mails("is ready in Smithers")).toHaveLength(0);
    // Confirmed: the cancel URL returned at confirmation removes the subscriber record.
    await f.call({ repo: "owner/other", email: "confirmed@example.com" });
    const confirmed = await (await f.confirm("confirmed@example.com")).json();
    const cancelToken = /cancel\?token=([0-9a-f]{32})/.exec(confirmed.cancel)![1]!;
    expect((await f.env.BUGS.list!({ prefix: "repo-subscriber:" })).keys).toHaveLength(1);
    expect(await (await f.call(undefined, `/cancel?token=${cancelToken}`)).json()).toEqual({ cancelled: true });
    expect((await f.env.BUGS.list!({ prefix: "repo-subscriber:" })).keys).toHaveLength(0);
    expect((await f.call(undefined, `/cancel?token=${cancelToken}`)).status).toBe(404);
    await f.call({ repo: "owner/other", appUrl: "https://app.smithers.sh/other" }, "/complete", true);
    expect(f.mails("is ready in Smithers")).toHaveLength(0);
  });
  test("confirmation sends are throttled per recipient across repositories", async () => {
    const f = fixture();
    for (const name of ["owner/r1", "owner/r2", "owner/r3", "owner/r4"]) {
      await f.env.BUGS.put(`repo-request:${name}`, JSON.stringify({ name, url: `https://github.com/${name}` }));
    }
    for (const name of ["owner/r1", "owner/r2", "owner/r3"]) {
      expect(await (await f.call({ repo: name, email: "fan@example.com" })).json()).toMatchObject({ subscribed: true });
    }
    expect(await (await f.call({ repo: "owner/r4", email: "fan@example.com" })).json()).toMatchObject({ subscribed: false, confirmation: "rate_limited" });
    expect(f.mails("Confirm your Smithers notification")).toHaveLength(3);
    expect((await f.env.BUGS.list!({ prefix: "repo-confirm:" })).keys).toHaveLength(3);
  });
  test("a failed confirmation send stores nothing and reports it", async () => {
    const f = fixture();
    f.emailStatus(500);
    expect(await (await f.call({ repo: "owner/repo", email: "fan@example.com" })).json()).toMatchObject({ subscribed: false, confirmation: "send_failed" });
    expect((await f.env.BUGS.list!({ prefix: "repo-confirm:" })).keys).toHaveLength(0);
    await f.complete();
    expect(f.mails("is ready in Smithers")).toHaveLength(0);
  });
  test("a repeated nomination of the same repo increments its count", async () => {
    const f = fixture();
    expect(await (await f.call({ repo: "owner/repo" })).json()).toMatchObject({ repo: { name: "owner/repo", nominations: 1 } });
    expect(await (await f.call({ repo: "https://github.com/Owner/Repo.git", email: "me@example.com" })).json()).toMatchObject({ repo: { nominations: 2 } });
    expect(await (await f.call(undefined, "?repo=OWNER/repo")).json()).toMatchObject({ repo: { name: "owner/repo", status: "smithering", nominations: 2 } });
    expect((await f.call(undefined, "?repo=owner/never")).status).toBe(404);
    expect((await f.call(undefined, "?repo=https://evil.com/owner/repo")).status).toBe(400);
  });
  test("rejected nominations do not count", async () => {
    const f = fixture();
    expect((await f.call({ repo: "owner/repo", email: "oops" })).status).toBe(400);
    f.github({ private: true, license: { spdx_id: "MIT" } });
    expect((await f.call({ repo: "owner/private" })).status).toBe(400);
    expect((await f.env.BUGS.list!({ prefix: "repo-nominations:" })).keys).toHaveLength(0);
  });
  test("counts are independent per repo and the public list ranks by count, capped at 20", async () => {
    const f = fixture();
    // Records beyond any fixed scan window: the leaderboard must still rank a late-sorting name first.
    for (let i = 0; i < 250; i++) await f.env.BUGS.put(`repo-request:owner/r${String(i).padStart(3, "0")}`, JSON.stringify({ name: `owner/r${i}`, url: `https://github.com/owner/r${i}` }));
    for (let i = 0; i < 22; i++) await f.call({ repo: `owner/r${i}` }, "", false, `10.0.0.${i}`);
    await f.call({ repo: "owner/second" }, "", false, "10.0.1.1");
    await f.call({ repo: "owner/zzz" }, "", false, "10.0.1.2");
    await f.call({ repo: "owner/zzz" }, "", false, "10.0.1.3");
    await f.call({ repo: "owner/second" }, "", false, "10.0.1.4");
    await f.call({ repo: "owner/zzz" }, "", false, "10.0.1.5");
    const response = await f.call();
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    const { repos } = await response.json();
    expect(repos).toHaveLength(20);
    expect(repos.slice(0, 3)).toMatchObject([
      { name: "owner/zzz", url: "https://github.com/owner/zzz", status: "smithering", nominations: 3 },
      { name: "owner/second", nominations: 2 },
      { name: "owner/r0", nominations: 1 },
    ]);
    expect(repos.slice(2).every((repo: { nominations: number }) => repo.nominations === 1)).toBe(true);
    expect(JSON.stringify(repos)).not.toContain("example.com");
    // Listing reads the leaderboard and each entry's readiness only, never the whole catalog.
    let reads = 0;
    const get = f.env.BUGS.get.bind(f.env.BUGS);
    f.env.BUGS.get = async (key: string) => { reads++; return get(key); };
    f.env.BUGS.list = async () => { throw new Error("list must not be used"); };
    expect((await f.call()).status).toBe(200);
    expect(reads).toBe(21);
  });
  test("limits payloads, throttles submissions, and reports storage failures", async () => {
    const f = fixture();
    expect((await f.call({ repo: "x".repeat(5000) })).status).toBe(413);
    for (let i = 0; i < 19; i++) await f.call({ repo: "owner/repo" });
    expect((await f.call({ repo: "owner/repo" })).status).toBe(429);
    f.env.BUGS.get = async () => { throw new Error("offline"); };
    expect((await f.call()).status).toBe(503);
  });
});
