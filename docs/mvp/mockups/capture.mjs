/* Generate documentation figures from local simulated prototypes, never production. */
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const require = createRequire(new URL("../../../apps/app/package.json", import.meta.url));
const { chromium } = require("playwright");
const directory = path.dirname(fileURLToPath(import.meta.url));
const figures = path.join(directory, "figures");
await mkdir(figures, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1120, height: 1100 }, colorScheme: "light" });
const errors = [], external = [], captured = [];
page.on("pageerror", error => errors.push(error.message));
await page.route(/^https?:/, route => { external.push(route.request().url()); return route.abort(); });
let inner, surface;
async function load(name) {
  await page.setViewportSize({ width: 1120, height: 1100 });
  await page.goto(pathToFileURL(path.join(directory, name + ".html")).href);
  inner = page.frameLocator("iframe");
  surface = inner.locator('div[id^="smithers-"]').first();
  await surface.waitFor();
}
async function capture(name, selector) {
  const target = selector ? inner.locator(selector) : surface;
  await target.screenshot({ path: path.join(figures, name + ".png"), animations: "disabled" });
  const bounds = await target.boundingBox();
  captured.push({ name, width: Math.round(bounds.width), height: Math.round(bounds.height), prototype: true });
}
async function scenario(label, value) {
  await page.getByLabel(label, { exact: true }).selectOption(value);
}

try {
  await load("start");
  await capture("01-start");
  for (const [job, name] of [["prs", "13-pr-review"], ["ci", "14-ci"], ["feature", "16-feature"], ["chore", "17-chore"]]) {
    await inner.locator('[data-job="' + job + '"]').click();
    await capture(name, ".sj-settings");
    await inner.locator('[data-action="back"]').click();
  }
  await page.setViewportSize({ width: 390, height: 1100 });
  await capture("02-start-mobile");

  await load("issues-setup");
  await capture("03-issues-flows");
  await inner.locator('[data-tab="prompts"]').click();
  await capture("04-issues-prompts", ".is-settings");
  await inner.locator('[data-tab="test"]').click();
  await capture("05-issues-test-preview", ".is-settings");
  await inner.locator("[data-evals]").click();
  await inner.locator("[data-eval-result]").filter({ hasText: "Required cases passed" }).waitFor();
  await scenario("Live test outcome", "Needs author");
  await inner.locator("[data-trial]").click();
  await capture("06-issues-trial-running");
  await inner.locator("[data-author-reply]").waitFor();
  await capture("07-issues-needs-author", ".is-settings");
  await inner.locator("[data-author-reply]").click();
  await inner.locator("[data-enable]:not([disabled])").waitFor();
  await capture("08-issues-ready", ".is-settings");
  await inner.locator("[data-test-title]").fill("[Smithers test] Revised fixture");
  await capture("09-issues-stale", ".is-settings");

  await load("issues-setup");
  await inner.locator('[data-tab="test"]').click();
  await scenario("Live test outcome", "Worker failure");
  await inner.locator("[data-trial]").click();
  await inner.getByText("Worker unavailable", { exact: true }).waitFor();
  await capture("10-issues-worker-failure", ".is-settings");

  await load("issue-work");
  await inner.locator("[data-fixture]").click();
  await capture("11-issue-repro");
  await inner.locator('[data-next="poc"]').click();
  await capture("12-issue-poc");
  await inner.locator('[data-next="fix"]').click();
  await capture("12b-issue-fix");
  await scenario("Issue scenario", "Large feature");
  await inner.locator('[data-next="split"]').click();
  await capture("12c-issue-split");

  await load("evals");
  await capture("18-evals-failure");
  await inner.locator("[data-improve]").click();
  await capture("19-evals-prompt");
  await inner.locator("[data-save-prompt]").click();
  await capture("20-evals-stale");
  await inner.locator("[data-suite]").selectOption("prs");
  await capture("13b-pr-evals");
  await inner.locator("[data-suite]").selectOption("chores");
  await capture("17b-chore-evals");

  // Rendered mobile check: document figures must not conceal clipped controls.
  const widths = [];
  for (const name of ["start", "issues-setup", "issue-work", "evals"]) {
    await load(name);
    await page.setViewportSize({ width: 320, height: 1100 });
    const frame = page.frames().find(value => value.parentFrame());
    const measure = await frame.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    widths.push({ name, ...measure });
    if (measure.scrollWidth > measure.clientWidth) errors.push(name + " overflows at 320px");
  }
  const receipt = { kind: "design-prototype-capture", productionVerified: false,
    captures: captured, widths, pageErrors: errors, externalRequests: external };
  await writeFile(path.join(directory, "capture-results.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify({ figures: captured.length, pageErrors: errors, externalRequests: external.length, widths }, null, 2));
  if (errors.length || external.length) process.exitCode = 1;
} finally {
  await browser.close();
}
