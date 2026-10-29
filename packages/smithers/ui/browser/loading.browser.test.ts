/**
 * The one loading pattern in real Chromium: nothing shows while a load is under LOADING_DELAY_MS; past it the page's
 * bar, the skeleton in place, the pending answer and a loading button show; nothing moves when the content takes the
 * skeleton's place; and under reduced motion the wait still holds while nothing moves. Computed opacity, transforms,
 * running animations and boxes are the browser's, which happy-dom can't compute. Run with `bun test browser`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { build } from "esbuild";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";

describe("loading browser probes", () => {
  const origin = "http://loading.test";
  let browser: Browser;
  let host: string;

  beforeAll(async () => {
    const result = await build({
      entryPoints: [join(import.meta.dir, "fixtures/loading.tsx")],
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

  const open = async (context: BrowserContext): Promise<Page> => {
    const page = await context.newPage();
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (url === `${origin}/`) {
        await route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html><body style="margin:0"><div id="app"></div><script src="/host.js"></script></body></html>`,
        });
      } else if (url === `${origin}/host.js`) {
        await route.fulfill({ contentType: "text/javascript", body: host });
      } else {
        await route.abort();
      }
    });
    await page.goto(`${origin}/`);
    await page.getByText("Below").waitFor();
    return page;
  };

  const BAR = '[data-slot="loading-bar"][data-placement="page"]';
  const SKELETON = '[data-testid="skeleton"]';
  const PENDING = ".sui-chat-bubble-pending";
  const BUTTON_BAR = '[data-slot="button"] [data-slot="loading-bar"]';

  type Peaks = { readonly bar: number; readonly skeleton: number; readonly pending: number; readonly button: number };

  /** Starts a load of `ms` and reads every frame for `forMs`: the highest opacity each loading element reached. */
  const sample = (page: Page, ms: number, forMs: number): Promise<Peaks> =>
    page.evaluate(
      ([ms, forMs, selectors]) =>
        new Promise<Peaks>((resolve) => {
          const peak = { bar: 0, skeleton: 0, pending: 0, button: 0 };
          const read = (selector: string) => {
            const element = document.querySelector(selector);
            return element === null ? 0 : Number(getComputedStyle(element).opacity);
          };
          const start = performance.now();
          window.load(ms);
          const frame = () => {
            peak.bar = Math.max(peak.bar, read(selectors[0]!));
            peak.skeleton = Math.max(peak.skeleton, read(selectors[1]!));
            peak.pending = Math.max(peak.pending, read(selectors[2]!));
            peak.button = Math.max(peak.button, read(selectors[3]!));
            if (performance.now() - start < forMs) requestAnimationFrame(frame);
            else resolve(peak);
          };
          requestAnimationFrame(frame);
        }),
      [ms, forMs, [BAR, SKELETON, PENDING, BUTTON_BAR]] as const,
    );

  const opacities = (page: Page) =>
    page.evaluate((selectors) => selectors.map((selector) => {
      const element = document.querySelector(selector);
      return element === null ? null : getComputedStyle(element).opacity;
    }), [BAR, SKELETON, PENDING, BUTTON_BAR]);

  const box = (page: Page, selector: string) =>
    page.$eval(selector, (element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return [x, y, width, height];
    });

  /** The running animations by name, pseudo-elements included. */
  const running = (page: Page) =>
    page.evaluate(() =>
      document
        .getAnimations()
        .filter((animation) => animation.playState === "running")
        .map((animation) => (animation as CSSAnimation).animationName),
    );

  const NOTHING: Peaks = { bar: 0, skeleton: 0, pending: 0, button: 0 };

  describe("the loading pattern", () => {
    test("a load under 300 ms shows nothing at all", async () => {
      const context = await browser.newContext();
      const page = await open(context);
      // Through the load and well past it: no frame drew the bar, the skeleton, the pending answer or the button's bar.
      expect(await sample(page, 200, 600)).toEqual(NOTHING);
      await page.getByTestId("content").waitFor();
      await context.close();
    }, 60_000);

    test("past 300 ms the bar, the skeleton, the pending answer and the button's bar show, then the bar settles", async () => {
      const context = await browser.newContext();
      const page = await open(context);
      expect(await sample(page, 1_500, 250)).toEqual(NOTHING);
      await page.waitForTimeout(450);
      expect(await opacities(page)).toEqual(["1", "1", "1", "1"]);
      expect(await page.getByRole("progressbar", { name: "Loading page" }).count()).toBe(1);
      // The sweep runs while it loads, and the skeleton pulses.
      expect(await running(page)).toEqual(expect.arrayContaining(["sui-loading-sweep", "sui-skeleton-pulse"]));
      await page.getByTestId("content").waitFor();
      // It fades out once the load settles, and leaves no progressbar behind.
      await page.waitForTimeout(400);
      expect(await page.$eval(BAR, (element) => getComputedStyle(element).opacity)).toBe("0");
      expect(await page.getByRole("progressbar").count()).toBe(0);
      await context.close();
    }, 60_000);

    test("nothing moves: the content takes the skeleton's box, and the answer's line takes the pending line's", async () => {
      const context = await browser.newContext();
      const page = await open(context);
      const idle = [await box(page, '[data-testid="region"]'), await box(page, '[data-testid="below"]'), await box(page, '[data-slot="button"]')];
      await page.evaluate(() => window.load(1_500));
      await page.waitForTimeout(700);
      const loading = [await box(page, '[data-testid="region"]'), await box(page, '[data-testid="below"]'), await box(page, '[data-slot="button"]')];
      const pending = await box(page, ".sui-chat-message .sui-chat-bubble");
      await page.getByTestId("content").waitFor();
      await page.waitForTimeout(300);
      const done = [await box(page, '[data-testid="region"]'), await box(page, '[data-testid="below"]'), await box(page, '[data-slot="button"]')];
      const answer = await box(page, ".sui-chat-message .sui-chat-bubble");
      expect(loading).toEqual(idle);
      expect(done).toEqual(idle);
      // Same place, same height: only the width follows the answer's words.
      expect([answer[0], answer[1], answer[3]]).toEqual([pending[0], pending[1], pending[3]]);
      await context.close();
    }, 60_000);

    test("under reduced motion the wait holds, the bar rests at full width and nothing animates", async () => {
      const context = await browser.newContext({ reducedMotion: "reduce" });
      const page = await open(context);
      expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
      expect(await sample(page, 200, 600)).toEqual(NOTHING);
      expect(await sample(page, 1_500, 250)).toEqual(NOTHING);
      await page.waitForTimeout(250);
      expect(await opacities(page)).toEqual(["1", "1", "1", "1"]);
      const bar = await page.$eval(BAR, (element) => {
        const before = getComputedStyle(element, "::before");
        return { transform: before.transform, width: before.width, barWidth: `${element.getBoundingClientRect().width}px` };
      });
      expect(bar.transform).toBe("none");
      expect(bar.width).toBe(bar.barWidth);
      expect(await running(page)).toEqual([]);
      await context.close();
    }, 60_000);
  });
});
