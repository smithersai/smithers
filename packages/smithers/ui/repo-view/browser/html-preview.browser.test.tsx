/** @jsxImportSource react */
/**
 * Browser probes: HtmlPreview in real Chromium. The page holds the frame
 * React renders for a repository HTML file, and every request off the page is
 * recorded and refused. A file that navigates itself, by script, meta refresh
 * or a `_self` link, must request nothing and leave the guard's note; a file
 * that reloads itself must stop after one reload instead of looping; a file
 * that stays put keeps its page. Run with `bun test browser`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Browser, chromium, type Frame } from "playwright";
import { renderToStaticMarkup } from "react-dom/server";
import { HtmlPreview } from "../src/HtmlPreview";

describe("HtmlPreview browser probes", () => {
  const origin = "http://probe.test";
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  interface Shown {
    /** Every URL the browser requested beyond the probe page. */
    readonly leaks: Array<string>;
    /** Whether the guard still holds the page's frame. */
    readonly framed: boolean;
    /** Whether the guard shows its note. */
    readonly noted: boolean;
    /** The page frame's text, when it is still there. */
    readonly text: string;
  }

  const show = async (html: string): Promise<Shown> => {
    const page = await browser.newPage();
    const leaks: Array<string> = [];
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (url === `${origin}/`) {
        await route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html><body>${renderToStaticMarkup(<HtmlPreview html={html} title="Preview of x.html" />)}</body></html>`,
        });
      } else {
        leaks.push(url);
        await route.abort();
      }
    });
    await page.goto(`${origin}/`);
    const guard: Frame = (await (await page.waitForSelector("iframe")).contentFrame())!;
    // Long enough for a timer, a meta refresh and a reload to have run.
    await page.waitForTimeout(1_000);
    const state = await guard.evaluate(() => ({
      framed: document.querySelector("iframe") !== null,
      noted: !document.querySelector("p")!.hidden,
    }));
    const inner = page.frames().find((frame) => frame.parentFrame() === guard);
    const text = state.framed && inner ? await inner.evaluate(() => document.body?.innerText ?? "") : "";
    await page.close();
    return { leaks, ...state, text };
  };

  const away = "https://attacker.test/";

  test.each([
    ["a script setting location as it loads", `<script>location.href = "${away}?" + Date.now()</script>`],
    ["a script setting location once loaded", `<p>x</p><script>setTimeout(() => location.replace("${away}later"), 100)</script>`],
    ["a meta refresh", `<meta http-equiv="refresh" content="0;url=${away}refresh">`],
    ["a meta refresh a script adds", `<script>const m = document.createElement("meta"); m.httpEquiv = "refresh"; m.content = "0;url=${away}added"; document.head.append(m)</script>`],
    ["a link aimed at _self", `<a id="a" target="_self" href="${away}self">go</a><script>document.getElementById("a").click()</script>`],
    ["a data: URL", `<script>location.href = "data:text/html,<script>fetch('${away}data')<\\/script>"</script>`],
  ])("a page that navigates itself by %s requests nothing and is replaced by the note", async (_, html) => {
    expect(await show(html)).toEqual({ leaks: [], framed: false, noted: true, text: "" });
  });

  test("a page that reloads itself once loaded is stopped at its second load, not reloaded forever", async () => {
    expect(await show(`<p>x</p><script>onload = () => setTimeout(() => location.reload(), 50)</script>`)).toEqual({
      leaks: [],
      framed: false,
      noted: true,
      text: "",
    });
  });

  test("a page that tries to navigate the guard or the app requests nothing", async () => {
    const shown = await show(
      `<p>stays</p><script>for (const w of [parent, top]) try { w.location.href = "${away}up" } catch {}</script>`,
    );
    expect(shown.leaks).toEqual([]);
  });

  test("a page that stays put keeps its page, its blocked fetch and image included", async () => {
    expect(
      await show(`<h1>Fork me</h1><img src="${away}img.png"><script>fetch("${away}fetch").catch(() => {})</script>`),
    ).toEqual({ leaks: [], framed: true, noted: false, text: "Fork me" });
  });
});
