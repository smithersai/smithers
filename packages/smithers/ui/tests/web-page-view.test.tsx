/** @jsxImportSource react */
// WebPageView under happy-dom: real createRoot + act. The preload disables
// iframe page loading, so no frame here touches the network.
import { webPageCss } from "@smthrs/ui-css";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Deferred, Effect, Layer } from "effect";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { WebPageLoad, WebPageLoadProvider, WebPageView } from "../src/web-page";
import { SMITHERS_UI_STYLE_ATTR } from "../src/styles";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const happyDOM = (globalThis as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM;

let container: HTMLElement | undefined;
let root: Root | undefined;

// Earlier suites click real links, and happy-dom navigates the shared window,
// so a page origin left behind could equal a test URL's origin.
beforeEach(() => happyDOM.setURL("about:blank"));

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  happyDOM.setURL("about:blank");
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((el) => el.remove());
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const mounted = root;
  await act(async () => mounted.render(element));
}

const $ = <E extends Element = HTMLElement>(selector: string) => container!.querySelector<E>(selector);

/**
 * Clicks `link` and reports whether the click was already default-prevented
 * when it reached a host listener on the document, which then prevents it so
 * happy-dom does not open a page.
 */
async function defaultPreventedBeforeHost(link: HTMLElement): Promise<boolean> {
  let prevented: boolean | undefined;
  const host = (event: Event) => {
    prevented = event.defaultPrevented;
    event.preventDefault();
  };
  document.addEventListener("click", host);
  try {
    await act(async () => {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  } finally {
    document.removeEventListener("click", host);
  }
  if (prevented === undefined) throw new Error("the click never reached the document");
  return prevented;
}

describe("WebPageView", () => {
  test("ships the component's rules in the injected sheet", async () => {
    await render(<WebPageView url="https://example.com/" />);
    expect(document.head.querySelector(`style[${SMITHERS_UI_STYLE_ATTR}]`)!.textContent)
      .toContain(webPageCss.trim());
  });

  test("frames the page with the exact sandbox, referrer policy and lazy loading, and no permission delegation", async () => {
    await render(<WebPageView url="https://example.com/docs?q=1" />);
    const frame = $<HTMLIFrameElement>("iframe")!;
    expect(container!.querySelectorAll("iframe")).toHaveLength(1);
    expect(frame.dataset.slot).toBe("web-page-frame");
    expect(frame.getAttribute("src")).toBe("https://example.com/docs?q=1");
    expect(frame.getAttribute("sandbox")).toBe(
      "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox",
    );
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("loading")).toBe("lazy");
    expect(frame.getAttribute("title")).toBe("Web page from example.com");
    expect(frame.hasAttribute("allow")).toBe(false);
    expect(frame.getAttribute("sandbox")).not.toMatch(/allow-top-navigation|allow-downloads|allow-modals/);
  });

  test("shows the origin as text and an Open in new tab link to the page", async () => {
    await render(<WebPageView url="https://example.com:8443/a/b" />);
    const figure = $("figure")!;
    expect([figure.dataset.slot, figure.dataset.size]).toEqual(["web-page-view", "inline"]);
    const caption = figure.querySelector("figcaption")!;
    expect(caption.querySelector("[data-slot=web-page-origin]")!.textContent).toBe("https://example.com:8443");
    const link = caption.querySelector<HTMLAnchorElement>("a[data-slot=web-page-open]")!;
    expect(link.textContent).toBe("Open in new tab");
    expect(link.getAttribute("href")).toBe("https://example.com:8443/a/b");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.className).toContain("sui-button");
    // The figcaption precedes the frame.
    expect(figure.firstElementChild).toBe(caption);
    expect(figure.lastElementChild!.firstElementChild!.tagName).toBe("IFRAME");
  });

  test("covers the frame with the page's preview until it loads, and again for a new page", async () => {
    await render(
      <WebPageView
        url="https://example.com/guide"
        preview={{ title: "Example guide", description: "Frames welcome.", icon: "data:image/png;base64,KioqKg==" }}
      />,
    );
    const figure = $("figure")!;
    expect(figure.dataset.state).toBe("loading");
    const pending = $("[data-slot=web-page-pending]")!;
    expect(pending.getAttribute("aria-hidden")).toBe("true");
    expect(pending.querySelector("[data-slot=web-page-title]")!.textContent).toBe("Example guide");
    expect(pending.querySelector("[data-slot=web-page-description]")!.textContent).toBe("Frames welcome.");
    expect(pending.querySelector("[data-slot=web-page-domain]")!.textContent).toBe("example.com");
    expect(pending.querySelector("img")!.getAttribute("src")).toBe("data:image/png;base64,KioqKg==");
    // The frame stays first, so the cover sits over it, and only the bar's link opens the page.
    expect(figure.lastElementChild!.firstElementChild!.tagName).toBe("IFRAME");
    expect(pending.querySelectorAll("a")).toHaveLength(0);

    await act(async () => {
      $("iframe")!.dispatchEvent(new Event("load"));
    });
    expect(figure.dataset.state).toBe("loaded");
    expect($("[data-slot=web-page-pending]")).toBeNull();

    await act(async () => root!.render(<WebPageView url="https://example.org/" />));
    expect(figure.dataset.state).toBe("loading");
    // With no preview, the cover names the domain.
    expect($("[data-slot=web-page-pending] [data-slot=web-page-title]")!.textContent).toBe("example.org");
  });

  test("a provided WebPageLoad decides when the cover leaves, and stops waiting for a frame that shows another page or leaves", async () => {
    const released = Deferred.makeUnsafe<void>();
    const waited: string[] = [];
    const interrupted: string[] = [];
    const held = Layer.succeed(WebPageLoad, WebPageLoad.of({
      loaded: (frame) => {
        const src = frame.getAttribute("src")!;
        return Effect.sync(() => waited.push(src)).pipe(
          Effect.andThen(src === "https://example.com/held" ? Deferred.await(released) : Effect.never),
          Effect.onInterrupt(() => Effect.sync(() => interrupted.push(src))),
        );
      },
    }));
    await render(<WebPageLoadProvider layer={held}><WebPageView url="https://example.com/held" /></WebPageLoadProvider>);
    const figure = $("figure")!;
    expect(waited).toEqual(["https://example.com/held"]);
    // The frame's own event no longer ends the cover under this layer: its service does.
    await act(async () => {
      $("iframe")!.dispatchEvent(new Event("load"));
    });
    expect(figure.dataset.state).toBe("loading");
    expect($("[data-slot=web-page-pending]")).not.toBeNull();
    await act(async () => {
      Deferred.doneUnsafe(released, Effect.void);
    });
    expect(figure.dataset.state).toBe("loaded");
    expect($("[data-slot=web-page-pending]")).toBeNull();

    await act(async () => root!.render(<WebPageLoadProvider layer={held}><WebPageView url="https://example.org/" /></WebPageLoadProvider>));
    expect(figure.dataset.state).toBe("loading");
    expect(waited).toEqual(["https://example.com/held", "https://example.org/"]);
    expect(interrupted).toEqual([]);
    await act(async () => root!.render(<WebPageLoadProvider layer={held}><WebPageView url="https://example.net/" /></WebPageLoadProvider>));
    expect(interrupted).toEqual(["https://example.org/"]);
    await act(async () => root!.render(<WebPageLoadProvider layer={held}>{null}</WebPageLoadProvider>));
    expect(interrupted).toEqual(["https://example.org/", "https://example.net/"]);
  });

  test("renders the normalized URL it checked, never the raw input", async () => {
    await render(<WebPageView url={"  HTTPS://Exa\tmple.COM/x\n"} />);
    expect($("iframe")!.getAttribute("src")).toBe("https://example.com/x");
    expect($("a")!.getAttribute("href")).toBe("https://example.com/x");
    expect($("[data-slot=web-page-origin]")!.textContent).toBe("https://example.com");
  });

  test("a click on Open in new tab reaches the browser's default action unprevented", async () => {
    await render(<WebPageView url="https://example.com/" />);
    expect(await defaultPreventedBeforeHost($("a")!)).toBe(false);
  });

  test("marks the full size and keeps the bar, link and frame", async () => {
    await render(<WebPageView url="https://example.com/" size="full" />);
    expect($("figure")!.dataset.size).toBe("full");
    expect(container!.querySelectorAll("figcaption, a[data-slot=web-page-open], iframe")).toHaveLength(3);
  });

  test("puts the actions between the origin and Open in new tab", async () => {
    await render(<WebPageView url="https://example.com/" actions={<a href="/chat/1/page">Full screen</a>} />);
    const bar = $("figcaption")!;
    expect([...bar.querySelectorAll("a")].map((link) => link.textContent)).toEqual(["Full screen", "Open in new tab"]);
    expect(bar.querySelector("[data-slot=web-page-actions]")!.contains(bar.querySelector("a[href='/chat/1/page']"))).toBe(true);
    expect(bar.firstElementChild!.getAttribute("data-slot")).toBe("web-page-origin");
  });

  test("takes a frame title, a class and pass-through attributes", async () => {
    await render(<WebPageView url="https://example.com/" title="Example docs" className="extra" id="page" data-turn="7" />);
    const figure = $("figure")!;
    expect([figure.id, figure.dataset.turn, figure.className]).toEqual(["page", "7", "sui-web-page-view extra"]);
    expect($("iframe")!.getAttribute("title")).toBe("Example docs");
  });

  test("a caller cannot override the frame's source, sandbox, referrer policy or permissions, or the structural attributes", async () => {
    const hostile = {
      src: "https://evil.example/",
      sandbox: "allow-scripts allow-top-navigation",
      referrerPolicy: "unsafe-url",
      allow: "camera; microphone",
      "data-slot": "other",
      "data-size": "huge",
    } as unknown as Record<string, string>;
    await render(<WebPageView url="https://example.com/" {...hostile} />);
    const frame = $<HTMLIFrameElement>("iframe")!;
    expect(frame.getAttribute("src")).toBe("https://example.com/");
    expect(frame.getAttribute("sandbox")).toBe(
      "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox",
    );
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.hasAttribute("allow")).toBe(false);
    expect([$("figure")!.dataset.slot, $("figure")!.dataset.size]).toEqual(["web-page-view", "inline"]);
  });

  describe("refuses, with no frame and no link", () => {
    const refused: ReadonlyArray<readonly [string, string]> = [
      ["javascript:", "javascript:alert(document.cookie)"],
      ["javascript: split by a tab", "java\tscript:alert(1)"],
      ["data:", "data:text/html,<script>alert(1)</script>"],
      ["file:", "file:///etc/passwd"],
      ["blob:", "blob:https://example.com/0b1c2d3e"],
      ["about:blank", "about:blank"],
      ["a relative path", "/settings"],
      ["a protocol-relative URL", "//evil.example/"],
      ["a tab-hidden protocol-relative URL", "/\t/evil.example"],
      ["credentials", "https://maya:secret@example.com/"],
      ["http", "http://example.com/"],
      ["http on localhost", "http://localhost:4000/"],
    ];
    for (const [name, url] of refused) {
      test(name, async () => {
        await render(<WebPageView url={url} className="extra" id="page" />);
        expect(container!.querySelectorAll("iframe, a, [href], [src]")).toHaveLength(0);
        const empty = $("[data-slot=web-page-view]")!;
        expect(empty.dataset.refused).toBe("true");
        expect(empty.textContent).toBe("Can't show this page");
        expect([empty.id, empty.className]).toEqual(["page", "sui-empty extra"]);
      });
    }

    test("the host's own origin and every page on its site", async () => {
      happyDOM.setURL("https://app.smithers.sh/chat/1");
      // A page on another site is shown.
      await render(<WebPageView url="https://example.com/" />);
      expect($("iframe")!.getAttribute("src")).toBe("https://example.com/");
      for (const url of ["https://app.smithers.sh/settings", "https://smithers.sh/", "https://docs.smithers.sh/"]) {
        await act(async () => root!.render(<WebPageView url={url} />));
        expect(container!.querySelectorAll("iframe, a")).toHaveLength(0);
        expect($("[data-slot=web-page-view]")!.dataset.refused).toBe("true");
      }
    });

    test("an https page on the host's host when the host is http on localhost", async () => {
      happyDOM.setURL("http://localhost:1337/");
      await render(<WebPageView url="https://localhost:1337/" />);
      expect(container!.querySelectorAll("iframe, a")).toHaveLength(0);
    });
  });

  test("refuses framing on the server, where the host origin is unknown", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window")!;
    delete (globalThis as { window?: unknown }).window;
    try {
      const html = renderToStaticMarkup(<WebPageView url="https://example.com/" />);
      expect(html).toContain('data-refused="true"');
      expect(html).not.toContain("<iframe");
    } finally {
      Object.defineProperty(globalThis, "window", descriptor);
    }
  });
});
