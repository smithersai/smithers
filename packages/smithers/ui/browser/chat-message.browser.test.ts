/**
 * A message's actions in real Chromium: its time and Copy (or Edit) are hidden
 * until the pointer is over the message, focus is inside it, or, on a touch
 * screen, it is tapped. Hover, focus and touch media are the browser's, which
 * happy-dom can't compute. Run with `bun test browser`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { build } from "esbuild";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";

describe("chat-message browser probes", () => {
  const origin = "http://chat-message.test";
  let browser: Browser;
  let host: string;

  beforeAll(async () => {
    const result = await build({
      entryPoints: [join(import.meta.dir, "fixtures/chat-message.tsx")],
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
    await page.locator('[data-id="answer"]').waitFor();
    // Past the messages' entry animation, so a measured box is where it rests.
    await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
    return page;
  };

  const message = (id: string) => `.sui-chat-message[data-id="${id}"]`;
  const actions = (id: string) => `${message(id)} .sui-chat-message-actions`;
  const bubble = (id: string) => `${message(id)} .sui-chat-bubble`;

  const opacity = (page: Page, selector: string) =>
    page.$eval(selector, (element) => getComputedStyle(element).opacity);

  /** Waits for the fade to finish at `value`, then reads every message's actions. */
  const shown = async (page: Page, id: string, value: "0" | "1") => {
    await page.waitForFunction(
      ([selector, expected]) => {
        const element = document.querySelector(selector!);
        return element !== null && getComputedStyle(element).opacity === expected;
      },
      [actions(id), value],
      { timeout: 2_000 },
    );
    // Past the 120 ms fade, so a message that is still fading reads as what it settles to.
    await page.waitForTimeout(200);
    return { question: await opacity(page, actions("question")), answer: await opacity(page, actions("answer")) };
  };

  const boxes = (page: Page) =>
    page.evaluate(() =>
      [...document.querySelectorAll(".sui-chat-message, .sui-chat-bubble, .sui-chat-message-meta, button")].map(
        (element) => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return [x, y, width, height];
        },
      ),
    );

  describe("message actions", () => {
    test("hidden until the pointer is over the message, and nothing moves when they show", async () => {
      const context = await browser.newContext();
      const page = await open(context);
      expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(true);
      await page.mouse.move(600, 2);

      // Hidden, but in the page: the time is there and keeps its space; the delivery state shows.
      expect(await opacity(page, actions("question"))).toBe("0");
      expect(await opacity(page, actions("answer"))).toBe("0");
      expect(await page.locator(`${actions("answer")} time`).textContent()).toBe("3m ago");
      expect(await opacity(page, `${message("question")} .sui-chat-message-meta`)).toBe("1");
      expect(await page.getByText("Queued", { exact: true }).isVisible()).toBe(true);
      const before = await boxes(page);

      await page.hover(bubble("answer"));
      expect(await shown(page, "answer", "1")).toEqual({ question: "0", answer: "1" });
      expect(await boxes(page)).toEqual(before);

      // Over the meta row too: moving down to Copy keeps them shown.
      await page.hover(`${actions("answer")} button`);
      expect(await shown(page, "answer", "1")).toEqual({ question: "0", answer: "1" });

      await page.hover(bubble("question"));
      expect(await shown(page, "question", "1")).toEqual({ question: "1", answer: "0" });

      await page.mouse.move(600, 2);
      expect(await shown(page, "question", "0")).toEqual({ question: "0", answer: "0" });
      expect(await boxes(page)).toEqual(before);
      await context.close();
    }, 60_000);

    test("focus inside a message shows its actions, so the keyboard reaches Edit and Copy", async () => {
      const context = await browser.newContext();
      const page = await open(context);
      await page.mouse.move(600, 2);
      await page.getByRole("button", { name: "Before" }).focus();

      // The message itself is never a tab stop: Tab goes on to its controls.
      for (let presses = 0; presses < 6; presses++) {
        await page.keyboard.press("Tab");
        if (await page.evaluate(() => document.activeElement?.textContent === "Edit")) break;
      }
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Edit");
      expect(await shown(page, "question", "1")).toEqual({ question: "1", answer: "0" });

      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Copy");
      expect(await shown(page, "answer", "1")).toEqual({ question: "0", answer: "1" });

      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Copied", exact: true }).waitFor();
      expect(await shown(page, "answer", "1")).toEqual({ question: "0", answer: "1" });

      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      expect(await shown(page, "answer", "0")).toEqual({ question: "0", answer: "0" });
      await context.close();
    }, 60_000);

    test("on a touch screen they stay hidden until the message is tapped", async () => {
      const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 700 } });
      const page = await open(context);
      expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
      expect(await opacity(page, actions("question"))).toBe("0");
      expect(await opacity(page, actions("answer"))).toBe("0");

      await page.tap(bubble("answer"));
      expect(await shown(page, "answer", "1")).toEqual({ question: "0", answer: "1" });

      // Tapping another message moves them there.
      await page.tap(bubble("question"));
      expect(await shown(page, "question", "1")).toEqual({ question: "1", answer: "0" });
      await context.close();
    }, 60_000);

    test("they fade in 120 ms, and at once under reduced motion", async () => {
      const context = await browser.newContext();
      const page = await open(context);
      const duration = () =>
        page.$eval(actions("answer"), (element) => Number.parseFloat(getComputedStyle(element).transitionDuration));
      expect(await duration()).toBe(0.12);
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(await duration()).toBeLessThan(0.001);
      await context.close();
    }, 60_000);
  });
});
