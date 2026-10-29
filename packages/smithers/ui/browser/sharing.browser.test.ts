/**
 * Sharing in real Chromium: the keyboard paths happy-dom can't drive. A
 * native button's Enter and Space, and Radix Select's own keys, are the
 * browser's, so these probes press them as a person would. Run with
 * `bun test browser`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { build } from "esbuild";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";

describe("sharing browser probes", () => {
  const origin = "http://sharing.test";
  let browser: Browser;
  let host: string;

  beforeAll(async () => {
    const result = await build({
      entryPoints: [join(import.meta.dir, "fixtures/sharing.tsx")],
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

  const open = async (): Promise<Page> => {
    const page = await browser.newPage();
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (url === `${origin}/`) {
        await route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html><body><div id="app"></div><script src="/host.js"></script></body></html>`,
        });
      } else if (url === `${origin}/host.js`) {
        await route.fulfill({ contentType: "text/javascript", body: host });
      } else {
        await route.abort();
      }
    });
    await page.goto(`${origin}/`);
    await page.getByRole("dialog", { name: "Share test-branch" }).waitFor();
    return page;
  };

  const log = (page: Page) => page.evaluate(() => window.log);

  /** Waits until the focused element reads `text`, as Radix moves focus after a frame. */
  const focused = (page: Page, text: string) =>
    page.waitForFunction((expected) => document.activeElement?.textContent === expected, text);

  describe("sharing by keyboard", () => {
    test("the dialog adds by Enter and by Share, picks access with the keyboard, and closes on Escape", async () => {
      const page = await open();
      const input = page.getByRole("textbox", { name: "Add people" });
      await expect(input.evaluate((el) => el === document.activeElement)).resolves.toBe(true);
      await page.keyboard.type("lee");
      await page.keyboard.press("Enter");
      await expect(input.inputValue()).resolves.toBe("");

      await page.keyboard.type("kim");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      await focused(page, "Can view");
      await page.keyboard.press("ArrowDown");
      await focused(page, "Can edit");
      await page.keyboard.press("Enter");
      await page.getByRole("combobox", { name: "Access", exact: true }).filter({ hasText: "Can edit" }).waitFor();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("listitem").filter({ hasText: "kim" }).count()).resolves.toBe(1);

      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "detached" });
      expect(await log(page)).toEqual([["add", "lee", "view"], ["add", "kim", "edit"], ["open", false]]);
      await page.close();
    }, 60_000);

    test("each avatar follows its person on Enter and on Space, and +N shows the rest on focus", async () => {
      const page = await open();
      await page.getByRole("button", { name: "Done" }).click();
      await page.getByRole("dialog").waitFor({ state: "detached" });
      const stack = page.getByRole("list", { name: "People here" });
      await stack.getByRole("button", { name: "maya" }).focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Tab");
      await expect(page.getByRole("tooltip").textContent()).resolves.toBe("jo");
      await page.keyboard.press(" ");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await expect(page.evaluate(() => document.activeElement?.textContent)).resolves.toBe("+2");
      await expect(page.getByRole("tooltip").textContent()).resolves.toBe("kim, ali");
      expect(await log(page)).toEqual([["open", false], ["follow", "u1"], ["follow", "u2"]]);
      await page.close();
    }, 60_000);
  });
});
