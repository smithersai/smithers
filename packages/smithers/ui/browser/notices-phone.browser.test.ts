/**
 * Notices at phone width in real Chromium, measured: the pending answer's `…` bubble sits centered in its bubble, with
 * equal room left and right (Will, 2026-10-20: "looks janky like it has more bubble on left side than right side");
 * the top bar's bell keeps `◆ Needs you` inside its pill; and the notifications panel fits the screen and scrolls
 * inside itself. Layout is the browser's, which happy-dom can't compute. Run with `bun test browser`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { build } from "esbuild";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";

describe("notices-phone browser probes", () => {
  const origin = "http://notices.test";
  const PHONE = { width: 390, height: 844 };
  let browser: Browser;
  let host: string;

  beforeAll(async () => {
    const result = await build({
      entryPoints: [join(import.meta.dir, "fixtures/notices.tsx")],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      target: "es2022",
      define: { "process.env.NODE_ENV": "\"production\"" },
      logLevel: "silent",
    });
    host = result.outputFiles[0]!.text;
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  const open = async (search = ""): Promise<Page> => {
    const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin && url.pathname === "/") {
        await route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html><body style="margin:0"><div id="app"></div><script src="/host.js"></script></body></html>`,
        });
      } else if (url.origin === origin && url.pathname === "/host.js") {
        await route.fulfill({ contentType: "text/javascript", body: host });
      } else {
        await route.abort();
      }
    });
    await page.goto(`${origin}/${search}`);
    await page.locator('[data-id="answer"] .sui-chat-bubble').waitFor();
    // Past every entry animation (the loading shimmer repeats forever), so a measured box is where it rests.
    await page.evaluate(() =>
      Promise.all(
        document.getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY)
          .map((animation) => animation.finished),
      )
    );
    return page;
  };

  /** The room between `inner`'s box and `outer`'s on each side, in CSS pixels. */
  const insets = (page: Page, outer: string, inner: string) =>
    page.evaluate(([outerSelector, innerSelector]) => {
      const box = document.querySelector(outerSelector!)!.getBoundingClientRect();
      const content = document.querySelector(innerSelector!)!.getBoundingClientRect();
      return { left: content.left - box.left, right: box.right - content.right, top: content.top - box.top, bottom: box.bottom - content.bottom };
    }, [outer, inner]);

  describe("notices at phone width", () => {
    test("the pending answer's bubble has as much room left of its line as right, and nothing spills out", async () => {
      const page = await open();
      const bubble = '[data-id="answer"] .sui-chat-bubble';
      const room = await insets(page, bubble, `${bubble} .sui-chat-pending-line`);
      expect(room.left).toBeGreaterThan(8);
      expect(Math.abs(room.left - room.right)).toBeLessThanOrEqual(1);
      expect(Math.abs(room.top - room.bottom)).toBeLessThanOrEqual(1);
      expect(await page.$eval(bubble, (element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.context().close();
    }, 60_000);

    test("the bell's ◆ Needs you sits inside its pill with even room, and the bell fits the screen", async () => {
      const page = await open();
      const bell = '[data-slot="notification-bell"]';
      const words = await insets(page, bell, `${bell} .sui-notification-needs`);
      const count = await insets(page, bell, `${bell} .sui-notification-count`);
      // a3ad64309497 puts the unread count in the phone's tap target, after the bell.
      expect(words.left).toBeGreaterThan(4);
      expect(Math.abs(words.left - count.right)).toBeLessThanOrEqual(1);
      const icon = await insets(page, bell, `${bell} svg`);
      expect(icon.right).toBeGreaterThan(count.right);
      expect(Math.abs(words.top - words.bottom)).toBeLessThanOrEqual(1);
      const { right } = await page.$eval(bell, (element) => element.getBoundingClientRect().toJSON() as DOMRect);
      expect(right).toBeLessThanOrEqual(PHONE.width);
      await page.context().close();
    }, 60_000);

    test("the panel takes the screen's width, its list scrolls inside it, and the page never scrolls sideways", async () => {
      const page = await open("?panel");
      const panel = await page.$eval('[data-slot="notification-panel"]', (element) => element.getBoundingClientRect().toJSON() as DOMRect);
      expect(panel.left).toBe(0);
      expect(panel.right).toBe(PHONE.width);
      expect(panel.bottom).toBeLessThanOrEqual(PHONE.height);
      expect(await page.$eval(".sui-notification-list", (element) => getComputedStyle(element).overflowY)).toBe("auto");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);
      // The expanded entry's question and Open fit inside the panel.
      const go = await page.getByRole("button", { name: "Open" }).boundingBox();
      expect(go!.x + go!.width).toBeLessThanOrEqual(PHONE.width);
      await page.context().close();
    }, 60_000);
  });
});
