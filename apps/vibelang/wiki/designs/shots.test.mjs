/** Run the archived screenshot commands with real Chromium in a relocated checkout. */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "@playwright/test";

const run = promisify(execFile);
const root = fileURLToPath(new URL("./", import.meta.url));
const playwright = fileURLToPath(new URL("./", import.meta.resolve("@playwright/test")));
const viewports = [
  ["desktop", { width: 1280, height: 800 }],
  ["phone", { width: 390, height: 844 }],
];
const names = {
  issues: ["issues", "tasks", "vips", "issue-open", "issue-commit", "issue-committed", "vip-1-summary",
    "vip-2-example", "vip-3-prior-art", "vip-4-review", "vip-in-review", "vip-accepted", "chat-agent-files",
    "chat-agent-splits", "roles", "issues-empty", "issues-loading", "issues-error", "issues-viewer", "issue-viewer"],
  media: ["map", "splash", "chat-empty", "chat-agent", "tour-1-contract", "tour-2-magic-move", "tour-3-token-bars",
    "tour-4-install", "tour-5-agent-loop", "tour-2-reduced", "tour-5-loading", "chat-empty-loading", "chat-empty-failed"],
  desktop: ["desktop", "phone", "desktop-pick", "phone-pick", "desktop-models", "phone-models", "desktop-folder",
    "phone-folder", "desktop-offline", "desktop-error", "phone-error", "desktop-loading"],
};

for (const design of Object.keys(names)) {
  test(`${design} screenshots use the sibling page and local dependency from any working directory`, async (t) => {
    const folder = mkdtempSync(join(tmpdir(), "design-shots-"));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    // Exercise URL escaping as well as relocation; Playwright is a real package dependency, never a double.
    const dir = join(folder, "reviewed design # % café", design);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(folder, "node_modules", "@playwright"), { recursive: true });
    symlinkSync(playwright, join(folder, "node_modules", "@playwright", "test"), "dir");
    cpSync(join(root, design, "shots.mjs"), join(dir, "shots.mjs"));
    const html = readFileSync(join(root, design, "index.html"), "utf8");
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const expected = new Map();
    // A visible edit to the checked-out page must appear in every output, including a second regeneration.
    for (const color of ["#123456", "#654321"]) {
      writeFileSync(join(dir, "index.html"), `${html}<style>
        html { overflow: hidden !important; }
        html::after { content: ""; position: fixed; inset: 0; z-index: 2147483647; background: ${color}; }
      </style>`);
      for (const [label, viewport] of viewports) {
        const page = await browser.newPage({ viewport });
        await page.setContent(`<style>html { background: ${color}; }</style>`);
        expected.set(label, await page.screenshot());
        await page.close();
      }
      await run(process.execPath, [join(dir, "shots.mjs")], { cwd: folder, timeout: 180_000 });
      const output = design === "desktop" ? dir : join(dir, "shots");
      const files = readdirSync(output).filter((file) => file.endsWith(".png")).sort();
      const wanted = design === "desktop" ? names[design].map((name) => `${name}.png`)
        : names[design].flatMap((name) => viewports.map(([label]) => `${name}-${label}.png`));
      assert.deepEqual(files, wanted.sort());
      for (const file of files) {
        const label = file.startsWith("phone") || file.endsWith("-phone.png") ? "phone" : "desktop";
        assert.deepEqual(readFileSync(join(output, file)), expected.get(label), `${file} must capture the edited sibling page`);
      }
    }
    if (design === "desktop") {
      for (const file of readdirSync(dir).filter((file) => file.endsWith(".png"))) rmSync(join(dir, file));
      await run(process.execPath, [join(dir, "shots.mjs"), "chat,error"], { cwd: folder, timeout: 180_000 });
      assert.deepEqual(readdirSync(dir).filter((file) => file.endsWith(".png")).sort(),
        ["desktop-error.png", "desktop.png", "phone-error.png", "phone.png"]);
    }
    assert.deepEqual(readdirSync(folder).sort(), ["node_modules", "reviewed design # % café"]);
  });
}
