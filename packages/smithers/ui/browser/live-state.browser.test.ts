/**
 * Live work's state icon in real Chromium (`ItemStatus.live`, apps/mvp ruling TODO-3): a live icon, in a list row and
 * in an item page's pill, blinks slowly, one calm 2-second cycle that dims and comes back; a steady icon never moves;
 * and under reduced motion the live icon holds still at full strength. Computed opacity and running animations are the
 * browser's, which happy-dom can't compute. Run with `bun test browser`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { build } from "esbuild";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";

describe("live-state browser probes", () => {
  const origin = "http://live-state.test";
  let browser: Browser;
  let host: string;

  beforeAll(async () => {
    const result = await build({
      entryPoints: [join(import.meta.dir, "fixtures/live-state.tsx")],
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
    await page.getByText("Add rate limit headers").waitFor();
    return page;
  };

  const ROW_LIVE = '[data-slot="issues-row"][data-live] .sui-issues-state';
  const ROW_STEADY = '[data-slot="issues-row"]:not([data-live]) .sui-issues-state';
  const PILL = ".sui-item-conv-state svg";

  type Watched = { readonly min: number; readonly max: number; readonly animations: ReadonlyArray<{ duration: number; iterations: number }> };

  /** Reads every frame for `forMs`: the lowest and highest opacity `selector` showed, and its running animations. */
  const watch = (page: Page, selector: string, forMs: number): Promise<Watched> =>
    page.evaluate(
      ([selector, forMs]) =>
        new Promise<Watched>((resolve) => {
          const element = document.querySelector(selector)!;
          let min = 1;
          let max = 0;
          const start = performance.now();
          const frame = () => {
            const opacity = Number(getComputedStyle(element).opacity);
            min = Math.min(min, opacity);
            max = Math.max(max, opacity);
            if (performance.now() - start < forMs) requestAnimationFrame(frame);
            else {
              resolve({
                min,
                max,
                animations: element.getAnimations().map((animation) => {
                  const timing = animation.effect!.getComputedTiming();
                  return { duration: Number(timing.duration), iterations: Number(timing.iterations) };
                }),
              });
            }
          };
          requestAnimationFrame(frame);
        }),
      [selector, forMs] as const,
    );

  describe("a live state icon", () => {
    test("blinks slowly in a row and in a page's pill: one 2 s cycle, dimming and coming back, without end", async () => {
      const context = await browser.newContext();
      const page = await open(context);
      for (const selector of [ROW_LIVE, PILL]) {
        const watched = await watch(page, selector, 2_200);
        expect(watched.animations).toEqual([{ duration: 2_000, iterations: Infinity }]);
        expect(watched.min).toBeLessThan(0.4);
        expect(watched.max).toBeGreaterThan(0.95);
      }
      await context.close();
    }, 30_000);

    test("a steady icon never moves", async () => {
      const context = await browser.newContext();
      const page = await open(context);
      const watched = await watch(page, ROW_STEADY, 1_200);
      expect(watched).toEqual({ min: 1, max: 1, animations: [] });
      await context.close();
    }, 30_000);

    test("under reduced motion a live icon holds still at full strength", async () => {
      const context = await browser.newContext({ reducedMotion: "reduce" });
      const page = await open(context);
      for (const selector of [ROW_LIVE, PILL]) {
        expect(await watch(page, selector, 1_200)).toEqual({ min: 1, max: 1, animations: [] });
      }
      await context.close();
    }, 30_000);
  });
});
