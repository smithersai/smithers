import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const dir = fileURLToPath(new URL("./", import.meta.url));
mkdirSync(`${dir}shots`, { recursive: true });

const screens = [
  ["s-issues", "issues"],
  ["s-tasks", "tasks"],
  ["s-vips", "vips"],
  ["s-issue", "issue-open"],
  ["s-commit", "issue-commit"],
  ["s-committed", "issue-committed"],
  ["s-vip1", "vip-1-summary"],
  ["s-vip2", "vip-2-example"],
  ["s-vip3", "vip-3-prior-art"],
  ["s-vip4", "vip-4-review"],
  ["s-vip-review", "vip-in-review"],
  ["s-vip-accepted", "vip-accepted"],
  ["s-chat-file", "chat-agent-files"],
  ["s-chat-split", "chat-agent-splits"],
  ["s-roles", "roles"],
];
const variants = [
  ["issues-empty", "s-issues", { state: "empty" }],
  ["issues-loading", "s-issues", { state: "loading" }],
  ["issues-error", "s-issues", { state: "error" }],
  ["issues-viewer", "s-issues", { role: "viewer" }],
  ["issue-viewer", "s-issue", { role: "viewer" }],
];

const browser = await chromium.launch();
for (const [name, id, opts] of [...screens.map(([id, n]) => [n, id, {}]), ...variants]) {
  for (const [label, width, height] of [["desktop", 1280, 800], ["phone", 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(new URL("./index.html", import.meta.url).href);
    await page.selectOption("#d-screen", id);
    if (opts?.role) await page.selectOption("#d-role", opts.role);
    if (opts?.state) await page.selectOption("#d-state", opts.state);
    await page.waitForTimeout(120);
    await page.screenshot({ path: `${dir}shots/${name}-${label}.png`, fullPage: false });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 0) console.log(`H-OVERFLOW ${name}-${label}: ${overflow}px`);
    await page.close();
  }
  console.log("done", name);
}
await browser.close();
