/** Chromium owns the inline layout and pointer hit testing that DOM emulators cannot reproduce. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { build } from "esbuild";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";

let browser: Browser;
let fixture: string;
beforeAll(async () => {
  const result = await build({
    entryPoints: [join(import.meta.dir, "fixtures/citation.tsx")],
    bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent",
  });
  fixture = result.outputFiles[0]!.text;
  browser = await chromium.launch({ headless: true });
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

for (const colorScheme of ["light", "dark"] as const) for (const index of [1, 2]) {
  test(`a pointer can cross citation ${index} in ${colorScheme} mode without moving its trigger`, async () => {
    const context = await browser.newContext({ colorScheme });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.setContent('<!doctype html><html><body><div id="app"></div></body></html>');
      await page.addScriptTag({ content: fixture });
      const citation = page.locator('[data-slot="inline-citation"]').nth(index - 1);
      const trigger = citation.locator('[data-slot="inline-citation-trigger"]');
      const content = citation.locator('[data-slot="inline-citation-content"]');
      const before = (await trigger.boundingBox())!;
      await trigger.hover();
      await content.waitFor({ state: "visible" });
      const after = (await trigger.boundingBox())!;
      expect(after.x).toBeCloseTo(before.x, 1);
      expect(after.y).toBeCloseTo(before.y, 1);
      const link = citation.locator(".sui-citation-card-link");
      const target = (await link.boundingBox())!;
      await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 40 });
      expect(await content.isVisible()).toBe(true);
      expect(await link.evaluate(element => element.matches(":hover"))).toBe(true);
      await page.mouse.move(900, 700);
      await content.waitFor({ state: "hidden" });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 30_000);
}

test("pointer leave keeps the keyboard-focused source mounted until focus leaves", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.setContent('<!doctype html><html><body><div id="app"></div></body></html>');
      await page.addScriptTag({ content: fixture });
    await page.locator('[data-slot="inline-citation-trigger"]').first().focus();
    const content = page.locator('[data-slot="inline-citation-content"]');
    await content.waitFor({ state: "visible" });
    const link = page.locator(".sui-citation-card-link");
    await link.focus();
    await link.hover();
    await page.mouse.move(900, 700);
    expect(await content.isVisible()).toBe(true);
    expect(await link.evaluate(element => element === document.activeElement)).toBe(true);
    await page.locator("#outside").focus();
    await content.waitFor({ state: "hidden" });
  } finally {
    await context.close();
  }
}, 30_000);


test("pressing preview text does not unmount it during the trigger's blur", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.setContent('<!doctype html><html><body><div id="app"></div></body></html>');
    await page.addScriptTag({ content: fixture });
    const trigger = page.locator('[data-slot="inline-citation-trigger"]').first();
    await trigger.focus();
    const content = page.locator('[data-slot="inline-citation-content"]');
    await content.waitFor({ state: "visible" });
    const excerpt = page.locator(".sui-citation-card-excerpt");
    const box = (await excerpt.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    expect(await content.isVisible()).toBe(true);
    await page.mouse.up();
    await trigger.focus();
    await page.locator("#outside").focus();
    await content.waitFor({ state: "hidden" });
  } finally {
    await context.close();
  }
}, 30_000);
