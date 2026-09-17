// Real signed-in probe against a deployed host using the persistent test profile.
// Usage: node apps/app/e2e/probes/signin-roundtrip.mjs [https://smithers.sh] [owner/repo]
//
// Proves the app's own sign-in door round trip: open the repository page, click "Sign in with
// GitHub", come back to that same repository page (return_to), and read "Account · @<user>" from
// the Account card. Never prints credentials: the password is read from a notes file outside the
// repository and only the redacted URL and the verdict reach stdout. Re-logs the saved GitHub test
// account in when the persistent session expired. When the profile is already signed in it clears
// only the host's cookies (never GitHub's) so the door appears and the round trip runs.
//
// The defaults below are overridable only through the environment (never through argv):
//   SMITHERS_E2E_PROFILE  persistent Chromium profile directory (default ~/.multi-e2e-profile)
//   SMITHERS_E2E_NOTES    notes file outside the repo holding a `password: <value>` line
//                         (default the multi-test-github-account memory file)
//   SMITHERS_E2E_USER     GitHub login of the test account (default codeplanesmithers)
//   SMITHERS_E2E_REQUIRE_NON_ADMIN  "1" fails the run when the session carries the admin claim
//
// The account is a SCOPED-DOWN one (Factory spec 2026-09-08, RULINGS 35): a plain signed-in
// GitHub login with no hand-seeded allowlist entry, so this probe proves the door works under the
// permissions a real visitor has. It reads the session back and prints the claims it found;
// `codeplanesmithers` carries the admin claim today, so refusing it would refuse every run.
// SMITHERS_E2E_REQUIRE_NON_ADMIN=1 restores the refusal for a run that must prove RULINGS 35.
// See apps/server/DEPLOY.md and apps/app/e2e/README.md.
//
// The persistent profile is shared with the real-E2E suites, so the run takes their atomic lease
// (`<profile>.smithers-real-e2e.lock`) before opening it and releases it on every exit.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { acquireProfileLease, ANY_SIGN_IN_DOOR, SIGN_IN_DOOR, visibleDoors } from "./support.mjs";
const base = (process.argv[2] ?? "https://smithers.sh").replace(/\/+$/, "");
const repo = process.argv[3] ?? "smithersai/smithers";
const home = homedir();
const profile = process.env.SMITHERS_E2E_PROFILE ?? join(home, ".multi-e2e-profile");
const notes = process.env.SMITHERS_E2E_NOTES
  ?? join(home, ".claude/projects/-Users-williamcory-multi/memory/multi-test-github-account.md");
const user = process.env.SMITHERS_E2E_USER ?? "codeplanesmithers";
const readPassword = () => {
  try { return (readFileSync(notes, "utf8").match(/password\s*[:=]\s*`?([^`\s]+)`?/i) || [])[1]; } catch { return undefined; }
};
const pass = readPassword();
const redact = (url) => url.replace(/state=[^&]+/, "state=…").replace(/code=[^&]+/, "code=…");
const host = new URL(base).hostname;
const hostCookies = new RegExp(`(^|\\.)${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const repoPath = `/${repo}`;
const lease = await acquireProfileLease(profile).catch((error) => {
  console.log("FAIL: the persistent profile is in use;", String(error?.message ?? error));
  process.exit(1);
});
const ctx = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const fail = async (why) => { console.log("FAIL:", why, "at", redact(page.url())); await ctx.close(); process.exit(1); };
const door = () => visibleDoors(page, SIGN_IN_DOOR).first();
const openRepo = async () => {
  await page.goto(`${base}${repoPath}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(7000);
};
await openRepo();
if (!(await door().count())) {
  // Already signed in: drop only this host's cookies so the door appears; GitHub's session stays.
  await ctx.clearCookies({ domain: hostCookies });
  await openRepo();
  if (!(await door().count())) await fail("no Sign in with GitHub door on the repository page after clearing the host cookies");
}
await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {}), door().click()]);
await page.waitForTimeout(2500);
if (/github\.com\/(login|session)/.test(page.url())) {
  if (!pass) await fail("saved GitHub session expired and no password line in the notes file (SMITHERS_E2E_NOTES)");
  await page.fill("#login_field", user); await page.fill("#password", pass);
  await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}), page.click('input[type="submit"][name="commit"]')]);
  await page.waitForTimeout(3000);
  const body = await page.evaluate(() => document.body.innerText);
  if (/github\.com/.test(page.url()) && /device verification|verification code|two-factor|Verify your device/i.test(body)) await fail("GitHub asks for a device or 2FA code; complete it once in the profile");
  if (/Incorrect username or password|does not support password/i.test(body)) await fail("GitHub refused the test account's credentials");
}
for (let i = 0; i < 3; i++) {
  const auth = page.getByRole("button", { name: /^authorize/i }).first();
  if (!(await auth.count())) break;
  await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}), auth.click()]);
  await page.waitForTimeout(3000);
}
await page.waitForTimeout(7000);
const landed = page.url();
if (!landed.startsWith(base)) await fail(`OAuth did not return to ${base}`);
const final = new URL(landed);
if (final.pathname !== repoPath) await fail(`the door returned to ${final.pathname}, not ${repoPath}`);
if (final.searchParams.has("signed-in")) await fail("the app left the signed-in marker in the query");
// Answered transcript steps retain their original sign-in prose, and the
// dismissed composer overlay keeps its own button in the DOM. A door is one the
// visitor can see, not one the page still holds.
if (await visibleDoors(page, ANY_SIGN_IN_DOOR).count()) {
  await fail("repository page still shows the sign-in door");
}
// Signed in, the header carries no account chrome; Account is the sidebar's button door.
const acct = page.locator("[data-testid=sidebar-account]");
if (!(await acct.isVisible())) await page.getByRole("button", { name: "Smithers", exact: true }).click();
try { await acct.waitFor({ state: "visible", timeout: 10000 }); }
catch { await fail("no Account sidebar button after opening the sidebar"); }
await acct.click(); await page.waitForTimeout(3000);
const t2 = await page.evaluate(() => document.body.innerText);
if (!new RegExp(`Account · @${user}`, "i").test(t2)) await fail("Account card does not name the test user");
// The scoped-down check: an admin session passes every assertion above while the product may
// refuse everyone else, so read the session back and say which claims carried the round trip.
const session = await page.evaluate(async () => {
  try {
    const r = await fetch("/api/auth/session", { credentials: "include" });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch (e) { return { status: 0, body: null, error: String(e) }; }
});
if (session.status !== 200 || !session.body?.login) await fail(`/api/auth/session answered ${session.status} with no login, so nothing shows this is a visitor's session`);
if (session.body.admin === true && process.env.SMITHERS_E2E_REQUIRE_NON_ADMIN === "1") {
  await fail(`the test account @${session.body.login} carries the admin claim and SMITHERS_E2E_REQUIRE_NON_ADMIN=1 (apps/server/DEPLOY.md)`);
}
if (session.body.admin === true) console.log(`admin=true: @${session.body.login} is in the identity Worker's ADMIN_LOGINS; the round trip above ran with that claim`);
console.log(`OK: the sign-in door returned to ${redact(landed)}; ${repo} signed in as @${user} (admin=${String(session.body.admin)}, allowlisted=${String(session.body.allowlisted)})`);
await ctx.close();
lease.release();
