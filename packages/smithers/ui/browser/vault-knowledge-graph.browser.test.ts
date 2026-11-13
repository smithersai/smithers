/**
 * Vault graph keyboard access in real Chromium: SVG note groups participate
 * in tab order, expose their labels, highlight on focus, and open on activation.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { build } from "esbuild";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";

let browser: Browser;
let host: string;

beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { KnowledgeGraph } from "./src/vault/KnowledgeGraph";
        function Host() {
          const [opened, setOpened] = useState([]);
          return <><KnowledgeGraph
            notes={[{ path: "Alpha.md", title: "Alpha" }, { path: "Beta.md", title: "Beta" }]}
            links={[{ source: "Alpha.md", target: "Beta.md" }]}
            onOpenNote={(path) => setOpened((paths) => [...paths, path])}
          /><output>{opened.join("|")}</output></>;
        }
        createRoot(document.getElementById("app")).render(<Host />);
      `,
      loader: "tsx",
      resolveDir: join(import.meta.dir, ".."),
    },
    bundle: true,
    jsx: "automatic",
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

afterAll(async () => { await browser?.close(); });

test("Tab reaches each labeled note, and Enter and Space open it once", async () => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(5_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setContent('<!doctype html><html><body><div id="app"></div></body></html>');
    await page.addScriptTag({ content: host });
    const graph = page.getByRole("group", { name: "Vault link graph" });
    await page.locator('[data-slot="vault-graph"]').waitFor().catch((error) => {
      throw new Error(`Graph did not mount: ${errors.join("; ")}`, { cause: error });
    });
    expect(errors).toEqual([]);
    expect(await graph.count()).toBe(1);
    expect(await graph.getByRole("button").allTextContents()).toHaveLength(2);
    await page.getByRole("button", { name: "Reset", exact: true }).focus();
    for (const label of ["Alpha", "Beta"]) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(label);
      expect(await page.locator(".sui-vault-graph-head").textContent()).toContain(`${label}.md`);
      await page.keyboard.press("Enter");
      await page.keyboard.press("Space");
    }
    expect(await page.locator("output").textContent()).toBe("Alpha.md|Alpha.md|Beta.md|Beta.md");
  } finally {
    await context.close();
  }
}, 30_000);
