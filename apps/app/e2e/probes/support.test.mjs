// Offline proof for the probe helpers: a real Chromium over `setContent`, no
// server and no deployed host. Run it with
// `bun test e2e/probes/support.test.mjs` from apps/app.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { acquireProfileLease, ANY_SIGN_IN_DOOR, SIGN_IN_DOOR, visibleDoors } from "./support.mjs";

const browser = await chromium.launch({ headless: true });
afterAll(async () => { await browser.close(); });

// What the 2026-09-17 production run met: the page is signed in, and the
// dismissed composer overlay still holds the sign-in button of an answered
// transcript step.
const signedInPage = `<div class="composer-overlay" style="display:none">
  <button data-flow="auth.sign-in">Sign in with GitHub</button>
</div><main><p>Account · @codeplanesmithers</p></main>`;

const signedOutPage = `<div class="composer-overlay" style="display:none">
  <button data-flow="auth.sign-in">Sign in with GitHub</button>
</div><button data-testid="chrome-sign-in">Sign in with GitHub</button>`;

const on = async (html) => {
  const page = await browser.newPage();
  await page.setContent(html);
  return page;
};

test("a hidden historical sign-in button is not a door", async () => {
  const page = await on(signedInPage);
  expect(await page.locator(ANY_SIGN_IN_DOOR).count()).toBe(1);
  expect(await visibleDoors(page, ANY_SIGN_IN_DOOR).count()).toBe(0);
  expect(await visibleDoors(page, SIGN_IN_DOOR).count()).toBe(0);
  await page.close();
});

test("a door the visitor can see still counts once", async () => {
  const page = await on(signedOutPage);
  expect(await visibleDoors(page, SIGN_IN_DOOR).count()).toBe(1);
  expect(await visibleDoors(page, ANY_SIGN_IN_DOOR).count()).toBe(1);
  expect(await visibleDoors(page, SIGN_IN_DOOR).first().isVisible()).toBe(true);
  await page.close();
});

test("the profile lease refuses a second owner and releases what it took", async () => {
  const profile = mkdtempSync(join(tmpdir(), "smithers-probe-profile-"));
  const first = await acquireProfileLease(profile);
  await expect(acquireProfileLease(profile)).rejects.toThrow();
  first.release();
  const second = await acquireProfileLease(profile);
  writeFileSync(`${second.lockPath}`, JSON.stringify({ pid: process.pid, nonce: "someone else" }));
  expect(() => second.release()).toThrow("Profile lease ownership changed before release");
  rmSync(second.lockPath);
  rmSync(profile, { recursive: true });
});
