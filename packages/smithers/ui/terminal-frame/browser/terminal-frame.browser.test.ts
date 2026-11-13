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
import vibelang from "vibelang-unplugin/esbuild";
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
      plugins: [vibelang({ tsconfig: join(import.meta.dir, "../tsconfig.json") })],
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
    "\x1b]8;;https://attacker.test/device\x07https://github.com/login/device\x1b]8;;\x07\r\n",
  ].join("");

  interface Opened {
    readonly page: Page;
    readonly frame: Frame;
    readonly leaks: Array<string>;
    readonly violations: Array<string>;
  }

  const open = async (probe: { readonly readOnly: boolean; readonly screenReaderMode?: boolean; readonly width?: number; readonly output?: string }): Promise<Opened> => {
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
            JSON.stringify({ ...probe, output: probe.output ?? output }).replace(/</g, "\\u003c")
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


    test("Tab and Shift+Tab enter and leave a read-only terminal", async () => {
      const { frame, page } = await open({ readOnly: true });
      await page.locator("#before-terminal").focus();
      await page.keyboard.press("Tab");
      expect(await frame.locator("textarea").evaluate((node) => node === document.activeElement)).toBe(true);
      await page.keyboard.press("Tab");
      expect(await page.locator("#after-terminal").evaluate((node) => node === document.activeElement)).toBe(true);
      await page.keyboard.press("Shift+Tab");
      expect(await frame.locator("textarea").evaluate((node) => node === document.activeElement)).toBe(true);
      await page.keyboard.press("Shift+Tab");
      expect(await page.locator("#before-terminal").evaluate((node) => node === document.activeElement)).toBe(true);
      expect((await log(page)).inputs).toEqual([]);
      await page.close();
    }, 60_000);

    test("a writable terminal keeps shell Tab and can release focus with Ctrl+Shift+M", async () => {
      const { page } = await open({ readOnly: false });
      await page.evaluate(() => window.focusTerminal());
      await page.keyboard.press("Tab");
      await logged(page, "window.log.inputs.length === 1");
      expect((await log(page)).inputs).toEqual(["\t"]);
      await page.keyboard.press("Control+Shift+m");
      await page.keyboard.press("Tab");
      expect(await page.locator("#after-terminal").evaluate((node) => node === document.activeElement)).toBe(true);
      expect((await log(page)).inputs).toEqual(["\t"]);
      await page.close();
    }, 60_000);

    test("screen-reader mode exposes shell output in the accessibility tree", async () => {
      const { frame, page } = await open({ readOnly: true, screenReaderMode: true });
      expect(await frame.locator(".xterm-accessibility").count()).toBe(1);
      await until(async () => (await frame.locator(".xterm-accessibility").textContent())?.includes("truecolor"));
      const accessible = await frame.locator("body").ariaSnapshot();
      expect(accessible).toContain("truecolor");
      expect(accessible).toContain("osc8 link");
      await page.close();
    }, 60_000);

    test("a misleading OSC 8 URL shows its target and needs a second click there", async () => {
      const { frame, page, leaks, violations } = await open({ readOnly: true });
      const box = (await frame.locator(".xterm-rows > div", { hasText: "https://github.com/login/device" }).boundingBox())!;
      await page.mouse.move(box.x + 30, box.y + box.height / 2);
      await until(() => frame.evaluate(() => document.querySelector(".xterm-screen.xterm-cursor-pointer") !== null));
      const strip = frame.locator("[data-smithers-terminal-link]");
      expect(await strip.innerText()).toBe("https://attacker.test/device");
      expect(await strip.isVisible()).toBe(true);
      await page.mouse.click(box.x + 30, box.y + box.height / 2);
      expect((await log(page)).links).toEqual([]);
      await strip.click();
      await logged(page, "window.log.links.length === 1");
      expect((await log(page)).links).toEqual([{ url: "https://attacker.test/device", active: true }]);
      expect(leaks).toEqual([]);
      expect(violations).toEqual([]);
      await page.close();
    }, 60_000);


    test.each(["https", "HTTPS", "hTtPs"])("a wrapped OSC 8 %s continuation still requires destination confirmation", async (scheme) => {
      const lines = output.replace("https://github.com/login/device", `${scheme}://github.com/login/device`);
      const { frame, page } = await open({ readOnly: true, width: 160, output: lines });
      const row = frame.locator(".xterm-rows > div", { hasText: "/login/device" });
      expect(await row.innerText()).not.toContain("https://");
      const box = (await row.boundingBox())!;
      await page.mouse.move(box.x + 30, box.y + box.height / 2);
      await until(() => frame.evaluate(() => document.querySelector(".xterm-screen.xterm-cursor-pointer") !== null));
      await page.mouse.click(box.x + 30, box.y + box.height / 2);
      expect((await log(page)).links).toEqual([]);
      const strip = frame.locator("[data-smithers-terminal-link]");
      expect(await strip.innerText()).toBe("https://attacker.test/device");
      expect(await strip.evaluate((node) => node === document.activeElement)).toBe(true);
      await page.keyboard.press("Enter");
      await logged(page, "window.log.links.length === 1");
      expect((await log(page)).links).toEqual([{ url: "https://attacker.test/device", active: true }]);
      await page.close();
    }, 60_000);


    test("a long destination preview lets the person click a bottom-row link", async () => {
      const target = "https://example.test/" + "a".repeat(180);
      const lines = output + `\x1b[999;1H\x1b]8;;${target}\x07open link\x1b]8;;\x07`;
      const { frame, page } = await open({ readOnly: false, output: lines });
      const box = (await frame.locator(".xterm-rows > div", { hasText: "open" }).boundingBox())!;
      await page.mouse.move(box.x + 30, box.y + box.height / 2);
      await until(() => frame.evaluate(() => document.querySelector(".xterm-screen.xterm-cursor-pointer") !== null));
      await page.mouse.click(box.x + 30, box.y + box.height / 2);
      await logged(page, "window.log.links.length === 1");
      expect((await log(page)).links).toEqual([{ url: target, active: true }]);
      await page.close();
    }, 60_000);

    test("a pending destination survives a resting pointer, and a double-click's second click never confirms it", async () => {
      const lines = output + "\x1b[999;1H\x1b]8;;https://attacker.test/device\x07https://github.com/bottom\x1b]8;;\x07";
      const { frame, page } = await open({ readOnly: true, output: lines });
      const box = (await frame.locator(".xterm-rows > div", { hasText: "https://github.com/bottom" }).boundingBox())!;
      await page.mouse.move(box.x + 30, box.y + box.height / 2);
      await until(() => frame.evaluate(() => document.querySelector(".xterm-screen.xterm-cursor-pointer") !== null));
      await page.mouse.click(box.x + 30, box.y + box.height / 2);
      const strip = frame.locator("[data-smithers-terminal-link]");
      await until(() => strip.isVisible());
      // xterm renders, and hovers the link under the resting pointer again, within this pause.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await strip.isEnabled()).toBe(true);
      expect(await strip.innerText()).toBe("https://attacker.test/device");
      // The second click of a double-click that began on the link, landing on the strip.
      const target = (await strip.boundingBox())!;
      await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
      await page.mouse.down({ clickCount: 2 });
      await page.mouse.up({ clickCount: 2 });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect((await log(page)).links).toEqual([]);
      await strip.click();
      await logged(page, "window.log.links.length === 1");
      expect((await log(page)).links).toEqual([{ url: "https://attacker.test/device", active: true }]);
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
