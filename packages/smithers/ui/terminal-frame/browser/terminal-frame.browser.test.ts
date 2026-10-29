/**
 * Browser probes: the terminal frame in real Chromium, under its own CSP.
 *
 * The page shows a TerminalFrame whose stream writes colored output and two
 * links. The probes check that xterm.js renders under the frame's policy
 * (its injected style sheets and 24-bit color `style` attributes included)
 * with no policy violation and no request off the page; that typing, ⌘K and
 * Ctrl+K, Esc and focus reach the page as the protocol says; that a read-only
 * frame sends nothing; and that a clicked link reaches the page with the
 * person's activation. Run with `bun test browser`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { build } from "esbuild";
import { join } from "node:path";
import { type Browser, chromium, type Frame, type Page } from "playwright";

describe("terminal-frame browser probes", () => {
  const origin = "http://probe.test";
  let browser: Browser;
  let host: string;

  beforeAll(async () => {
    const result = await build({
      entryPoints: [join(import.meta.dir, "fixtures/terminal-host.tsx")],
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

  const output = [
    "\x1b[38;2;255;0;0mtruecolor\x1b[0m plain\r\n",
    "https://example.test/plain is a link\r\n",
    "\x1b]8;;https://example.test/osc8\x07osc8 link\x1b]8;;\x07\r\n",
  ].join("");

  interface Opened {
    readonly page: Page;
    readonly frame: Frame;
    readonly leaks: Array<string>;
    readonly violations: Array<string>;
  }

  const open = async (probe: { readonly readOnly: boolean }): Promise<Opened> => {
    const page = await browser.newPage();
    const leaks: Array<string> = [];
    const violations: Array<string> = [];
    page.on("console", (message) => {
      if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text());
    });
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (url === `${origin}/`) {
        await route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html><body><div id="app"></div><script>window.probe = ${
            JSON.stringify({ ...probe, output }).replace(/</g, "\\u003c")
          }</script><script src="/host.js"></script></body></html>`,
        });
      } else if (url === `${origin}/host.js`) {
        await route.fulfill({ contentType: "text/javascript", body: host });
      } else {
        if (!url.startsWith(origin)) leaks.push(url);
        await route.abort();
      }
    });
    await page.goto(`${origin}/`);
    const handle = await page.waitForSelector("iframe");
    const frame = (await handle.contentFrame())!;
    // xterm renders a space as U+00A0.
    await until(() => frame.evaluate(() => document.querySelector(".xterm-rows")?.textContent?.includes("osc8\u00a0link")));
    return { page, frame, leaks, violations };
  };

  /**
   * Polls `check` until it holds. The frame's policy forbids `eval`, which
   * Playwright's `waitForFunction` needs, so conditions in the frame are polled
   * through `evaluate`.
   */
  const until = async (check: () => Promise<unknown>, timeoutMs = 20_000) => {
    const start = Date.now();
    while (!(await check())) {
      if (Date.now() - start > timeoutMs) throw new Error("until timed out");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  const log = (page: Page) => page.evaluate(() => window.log);

  /** Waits until the page's log satisfies `done`. */
  const logged = (page: Page, done: string) => page.waitForFunction(done);

  describe("the terminal frame in Chromium", () => {
    test("renders xterm under its policy: injected sheets and 24-bit color apply, nothing is refused or fetched", async () => {
      const { frame, leaks, page, violations } = await open({ readOnly: false });
      const rendered = await frame.evaluate(() => {
        const red = Array.from(document.querySelectorAll(".xterm-rows span")).find((span) => span.textContent === "truecolor")!;
        return {
          red: getComputedStyle(red).color,
          rows: getComputedStyle(document.querySelector(".xterm-rows")!).color,
          url: location.href,
          csp: document.querySelector("meta[http-equiv=Content-Security-Policy]")!.getAttribute("content"),
        };
      });
      expect(rendered.red).toBe("rgb(255, 0, 0)");
      expect(rendered.rows).toBe("rgb(33, 29, 24)");
      expect(rendered.url).toBe("about:srcdoc");
      expect(rendered.csp).toContain("connect-src 'none'");
      const { sizes } = await log(page);
      expect(sizes.length).toBeGreaterThan(0);
      expect(sizes.at(-1)![0]).toBeGreaterThan(80);
      expect(violations).toEqual([]);
      expect(leaks).toEqual([]);
      await page.close();
    }, 60_000);

    test("sends typing, Esc and focus to the page, and ⌘K and Ctrl+K to the page's shortcuts only", async () => {
      const { page } = await open({ readOnly: false });
      await page.evaluate(() => window.focusTerminal());
      await page.keyboard.type("ls");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Meta+k");
      await page.keyboard.press("Control+k");
      await page.keyboard.press("Enter");
      await logged(page, "window.log.inputs.join('').endsWith('\\r')");
      const { inputs, keys } = await log(page);
      expect(inputs.join("")).toBe("ls\x1b\r");
      expect(keys.map((key) => [key.key, key.metaKey, key.ctrlKey])).toEqual([["k", true, false], ["k", false, true]]);
      await page.close();
    }, 60_000);

    test("read-only sends no input at all", async () => {
      const { frame, page } = await open({ readOnly: true });
      await frame.click(".xterm-screen");
      await page.keyboard.type("rm -rf /");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Control+k");
      await logged(page, "window.log.keys.length === 1");
      expect((await log(page)).inputs).toEqual([]);
      await page.close();
    }, 60_000);

    test("passes a clicked link to the page, with the person's activation", async () => {
      const { frame, page } = await open({ readOnly: false });
      for (const text of ["https://example.test/plain", "osc8"]) {
        const box = (await frame.locator(".xterm-rows > div", { hasText: text }).boundingBox())!;
        // xterm finds a link on hover, then follows it on the click.
        await page.mouse.move(box.x + 30, box.y + box.height / 2);
        await until(() => frame.evaluate(() => document.querySelector(".xterm-screen.xterm-cursor-pointer") !== null));
        await page.mouse.down();
        await page.mouse.up();
      }
      await logged(page, "window.log.links.length === 2");
      expect((await log(page)).links).toEqual([
        { url: "https://example.test/plain", active: true },
        { url: "https://example.test/osc8", active: true },
      ]);
      await page.close();
    }, 60_000);
  });
});
