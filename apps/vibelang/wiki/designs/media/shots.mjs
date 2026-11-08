import { createRequire } from "node:module";
const { chromium } = createRequire("/Users/williamcory/smithers-builders/vl-mono/apps/vibelang/package.json")("@playwright/test");
import { pathToFileURL } from "node:url";
import { mkdirSync } from "node:fs";

const dir = "/Users/williamcory/smithers-builders/vl-designs/media";
mkdirSync(`${dir}/shots`, { recursive: true });

const screens = [
  ["s-map", "map", {}],
  ["s-splash", "splash", { video: 4 }],
  ["s-chat-empty", "chat-empty", {}],
  ["s-chat-agent", "chat-agent", {}],
  ["s-tour-1", "tour-1-contract", {}],
  ["s-tour-2", "tour-2-magic-move", { video: 8 }],
  ["s-tour-3", "tour-3-token-bars", {}],
  ["s-tour-4", "tour-4-install", {}],
  ["s-tour-5", "tour-5-agent-loop", { video: 12 }],
  ["s-tour-2", "tour-2-reduced", { state: "reduced" }],
  ["s-tour-5", "tour-5-loading", { state: "loading" }],
  ["s-chat-empty", "chat-empty-loading", { state: "loading" }],
  ["s-chat-empty", "chat-empty-failed", { state: "failed" }],
];

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
for (const [id, name, opts] of screens) {
  for (const [label, width, height] of [["desktop", 1280, 800], ["phone", 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(pathToFileURL(`${dir}/index.html`).href);
    await page.selectOption("#d-screen", id);
    if (opts.state) await page.selectOption("#d-state", opts.state);
    if (opts.video != null) {
      await page.evaluate((t) => {
        document.querySelectorAll('.d-screen[data-on="true"] video').forEach(v => { v.currentTime = t; v.pause(); });
      }, opts.video);
    }
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/shots/${name}-${label}.png`, fullPage: false });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 0) console.log(`H-OVERFLOW ${name}-${label}: ${overflow}px`);
    await page.close();
  }
  console.log("done", name);
}
await browser.close();
