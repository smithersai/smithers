import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { build } from "esbuild";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";

describe("component-library browser access", () => {
  let browser: Browser;
  let bundle: string;
  const origin = "http://component-library.test";

  beforeAll(async () => {
    const result = await build({
      entryPoints: [join(import.meta.dir, "fixtures/component-library.tsx")],
      bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    bundle = result.outputFiles[0]!.text;
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => { await browser?.close(); });

  async function open() {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (url === origin + "/") await route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="app"></div><script src="/host.js"></script>' });
      else if (url === origin + "/host.js") await route.fulfill({ contentType: "text/javascript", body: bundle });
      else await route.abort();
    });
    await page.goto(origin + "/");
    await page.getByRole("button", { name: "API suite" }).waitFor();
    return page;
  }

  test("overlapping event links have disjoint hit boxes and can each be activated", async () => {
    const page = await open();
    try {
      const week = page.locator('[data-example="week"]');
      const first = week.getByRole("link", { name: "First event", exact: false });
      const second = week.getByRole("link", { name: "Second event", exact: false });
      const a = (await first.boundingBox())!;
      const b = (await second.boundingBox())!;
      expect(a.width).toBeGreaterThan(0);
      expect(b.width).toBeGreaterThan(0);
      expect(a.x + a.width).toBeLessThanOrEqual(b.x);
      await first.click();
      expect(new URL(page.url()).hash).toBe("#first");
      await second.click();
      expect(new URL(page.url()).hash).toBe("#second");
    } finally { await page.close(); }
  });

  test("Tab reaches a Plan Tree receipt and Enter opens it without sending a referrer", async () => {
    const referrers: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      if (request.url === "/") {
        response.writeHead(200, { "content-type": "text/html" }).end('<div id="app"></div><script src="/host.js"></script>');
      } else if (request.url === "/host.js") {
        response.writeHead(200, { "content-type": "application/javascript" }).end(bundle);
      } else if (request.url === "/receipt.json") {
        referrers.push(request.headers.referer);
        response.writeHead(200, { "content-type": "application/json" }).end('{"result":"fixture"}');
      } else response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(base);
      await page.getByRole("button", { name: "Qualification" }).focus();
      await page.keyboard.press("Tab");
      const href = new URL("/receipt.json", base).href;
      const source = page.getByRole("link", { name: href, exact: true });
      expect(await source.evaluate(a => a === document.activeElement)).toBe(true);
      expect(referrers).toHaveLength(0);
      const opened = page.waitForEvent("popup");
      await page.keyboard.press("Enter");
      const receipt = await opened;
      await receipt.waitForURL(href);
      expect(await receipt.locator("body").innerText()).toContain('"result":"fixture"');
      expect(referrers).toEqual([undefined]);
      expect(await receipt.evaluate(() => window.opener === null)).toBe(true);
    } finally { await context.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }, 30_000);

  test("Chromium exposes grid rows, agenda links, source lists and the change summary", async () => {
    const page = await open();
    try {
      expect(await page.locator('[data-example="month"]').getByRole("row").count()).toBe(7);
      expect(await page.locator('[data-example="agenda"]').getByRole("link").count()).toBe(2);
      const sources = page.getByRole("list", { name: "Used 2 sources" });
      expect(await sources.getByRole("listitem").count()).toBe(2);
      expect(await page.getByRole("img", { name: "1 addition, 1 deletion, 1 file changed in this diff" }).count()).toBe(1);
      expect(await page.getByRole("progressbar", { name: "Test progress" }).getAttribute("aria-valuenow")).toBe("100");
      await page.getByRole("button", { name: "API suite", exact: true }).click();
      expect(await page.getByRole("region", { name: "API suite" }).textContent()).toContain("responds");
    } finally { await page.close(); }
  });

  test("overflow dialog label and padding do not activate the underlying day", async () => {
    const page = await open();
    try {
      const month = page.locator('[data-example="month"]');
      await month.getByRole("button", { name: "+1 more" }).click();
      const dialog = month.getByRole("dialog");
      await dialog.locator(".sui-cal-popover-label").click();
      await dialog.click({ position: { x: 3, y: 3 } });
      expect(await page.getByLabel("Slot clicks").textContent()).toBe("0");
      await dialog.getByRole("link", { name: "Second event", exact: false }).click();
      expect(await page.getByLabel("Slot clicks").textContent()).toBe("0");
      await month.locator('[data-date="2026-07-27"] .sui-cal-day-num').click();
      expect(await page.getByLabel("Slot clicks").textContent()).toBe("1");
    } finally { await page.close(); }
  });
});

