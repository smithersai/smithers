/** Computed styles and layout in Chromium; the unit suite checks sheet membership only. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { build } from "esbuild";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";

let browser: Browser;
let host: string;

beforeAll(async () => {
  const result = await build({
    entryPoints: [join(import.meta.dir, "fixtures/component-layout.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  host = result.outputFiles[0]!.text;
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => { await browser?.close(); });

async function open(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(5_000);
  await page.route("https://outside.test/**", (route) => route.abort());
  await page.setContent(`<!doctype html><style>
    * { box-sizing:border-box; }
    :root { --ctl-h:36px; --ctl-h-sm:28px; }
  </style><div id="app"></div>`);
  await page.addScriptTag({ content: host });
  await page.getByRole("radiogroup", { name: "Small", exact: true }).waitFor();
  return page;
}

test("full web pages fill the container and the frame takes the space below the bar", async () => {
  const page = await open();
  try {
    const boxes = await page.evaluate(() => {
      const box = (selector: string) => {
        const { top, bottom, height } = document.querySelector(selector)!.getBoundingClientRect();
        return { top, bottom, height };
      };
      return {
        container: box("#full"),
        figure: box("#full figure"),
        bar: box("#full figcaption"),
        frame: box("#full iframe"),
        inline: box("#inline iframe"),
        links: document.querySelectorAll("[data-slot='web-page-open']").length,
      };
    });
    expect(boxes.figure.height).toBe(boxes.container.height);
    expect(boxes.figure.top).toBe(boxes.container.top);
    expect(boxes.frame.top).toBeCloseTo(boxes.bar.bottom, 0);
    expect(boxes.frame.bottom).toBeCloseTo(boxes.figure.bottom - 1, 0);
    expect(boxes.frame.height).toBeGreaterThan(100);
    expect(boxes.inline.height).toBe(28 * 16);
    expect(boxes.links).toBe(2);
  } finally { await page.close(); }
});

test("segment sizes, borders, checked background and disabled strike-through survive the cascade", async () => {
  const page = await open();
  try {
    const styles = await page.evaluate(() => {
      const regular = document.querySelector<HTMLElement>('[aria-label="Regular"]')!;
      const small = document.querySelector<HTMLElement>('[aria-label="Small"]')!;
      const [checked, unchecked, disabled] = [...small.querySelectorAll("button")].map((node) => getComputedStyle(node));
      return {
        regularHeight: regular.getBoundingClientRect().height,
        smallHeight: small.getBoundingClientRect().height,
        border: getComputedStyle(small).borderTopWidth,
        divider: unchecked!.borderLeftWidth,
        checked: checked!.backgroundColor,
        unchecked: unchecked!.backgroundColor,
        disabledDecoration: disabled!.textDecorationLine,
        disabledColor: disabled!.color,
        enabledColor: unchecked!.color,
      };
    });
    expect(styles.regularHeight).toBe(36);
    expect(styles.smallHeight).toBe(28);
    expect(styles.border).toBe("1px");
    expect(styles.divider).toBe("1px");
    expect(styles.checked).not.toBe(styles.unchecked);
    expect(styles.disabledDecoration).toContain("line-through");
    expect(styles.disabledColor).not.toBe(styles.enabledColor);
  } finally { await page.close(); }
});

test("code text uses a mono font and the wordmark keeps its SVG aspect ratio", async () => {
  const page = await open();
  try {
    const styles = await page.evaluate(() => {
      const area = document.querySelector("textarea")!;
      const wordmark = document.querySelector<SVGSVGElement>(".sui-wordmark")!;
      const box = wordmark.getBoundingClientRect();
      return {
        font: getComputedStyle(area).fontFamily,
        whitespace: getComputedStyle(area).whiteSpace,
        width: box.width,
        height: box.height,
        ratio: wordmark.viewBox.baseVal.height / wordmark.viewBox.baseVal.width,
      };
    });
    expect(styles.font).toContain("monospace");
    expect(styles.whitespace).toBe("pre");
    expect(styles.width).toBe(300);
    expect(styles.height).toBeCloseTo(styles.width * styles.ratio, 0);
  } finally { await page.close(); }
});
