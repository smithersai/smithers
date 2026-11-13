/** @jsxImportSource react */
// WebLinkCard under happy-dom: real createRoot + act.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WebLinkCard } from "../src/web-page";
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

describe("WebLinkCard", () => {
  test("shows the domain and an Open in new tab link with its key, styled as a button, to the page in a new tab", async () => {
    await render(<WebLinkCard url="https://example.com/docs?q=1" />);
    const card = $("[data-slot=web-link-card]")!;
    expect(card.className).toContain("sui-web-link-card");
    // No title from the page: the domain is the title, shown once, beside the host's first letter.
    expect(card.querySelector("[data-slot=web-page-title]")!.textContent).toBe("example.com");
    expect(card.querySelectorAll("[data-slot=web-page-domain], [data-slot=web-page-description], img")).toHaveLength(0);
    expect(card.querySelector("[data-slot=web-page-icon]")!.textContent).toBe("E");
    const link = card.querySelector<HTMLAnchorElement>("a[data-slot=web-link-open]")!;
    expect(link.textContent).toBe("Open in new tab↵");
    expect(link.querySelector("kbd")!.getAttribute("aria-hidden")).toBe("true");
    expect(link.getAttribute("aria-keyshortcuts")).toBe("Enter");
    expect(link.getAttribute("href")).toBe("https://example.com/docs?q=1");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("aria-label")).toBe("Open in new tab: example.com");
    expect(link.className.split(" ")).toEqual(expect.arrayContaining(["sui-button", "sui-button-default", "sui-button-sm"]));
    expect(container!.querySelectorAll("a, iframe")).toHaveLength(1);
  });

  test("shows the page's title, description, domain and host-served icon", async () => {
    await render(
      <WebLinkCard
        url="https://www.example.com:8443/guide"
        title=" Example guide "
        description="How to frame pages, and what to do when they refuse."
        icon="data:image/png;base64,KioqKg=="
      />,
    );
    const card = $("[data-slot=web-link-card]")!;
    expect(card.querySelector("[data-slot=web-page-title]")!.textContent).toBe("Example guide");
    expect(card.querySelector("[data-slot=web-page-description]")!.textContent).toBe(
      "How to frame pages, and what to do when they refuse.",
    );
    expect(card.querySelector("[data-slot=web-page-domain]")!.textContent).toBe("www.example.com:8443");
    const icon = card.querySelector<HTMLImageElement>("[data-slot=web-page-icon] img")!;
    expect([icon.getAttribute("src"), icon.getAttribute("alt"), icon.getAttribute("referrerpolicy")]).toEqual([
      "data:image/png;base64,KioqKg==",
      "",
      "no-referrer",
    ]);
    expect(card.querySelector("[data-slot=web-page-icon]")!.getAttribute("aria-hidden")).toBe("true");
    expect($("a")!.getAttribute("aria-label")).toBe("Open in new tab: Example guide");
  });

  test("an icon that fails to load, or is not host-served, shows the host's first letter", async () => {
    await render(<WebLinkCard url="https://www.example.com/" title="Example" icon="data:image/png;base64,KioqKg==" />);
    const img = $("[data-slot=web-page-icon] img")!;
    await act(async () => {
      img.dispatchEvent(new Event("error"));
    });
    expect($("[data-slot=web-page-icon] img")).toBeNull();
    expect($("[data-slot=web-page-icon]")!.textContent).toBe("E");
    // A new icon is tried again.
    await act(async () => root!.render(<WebLinkCard url="https://www.example.com/" title="Example" icon="data:image/png;base64,AAAA" />));
    expect($("[data-slot=web-page-icon] img")!.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    for (const icon of ["http://cdn.example.com/i.png", "https://cdn.example.com/i.png", "https://u:p@cdn.example.com/i.png", " "]) {
      await act(async () => root!.render(<WebLinkCard url="https://www.example.com/" icon={icon} />));
      expect([icon, $("[data-slot=web-page-icon] img")]).toEqual([icon, null]);
    }
  });

  test("an http page shows its whole origin, so the scheme shows; blank text is no text", async () => {
    await render(<WebLinkCard url="http://localhost:5173/" title="Local" description="  " />);
    expect($("[data-slot=web-page-domain]")!.textContent).toBe("http://localhost:5173");
    expect($("[data-slot=web-page-description]")).toBeNull();
    await act(async () => root!.render(<WebLinkCard url="http://localhost:5173/" title="   " />));
    expect($("[data-slot=web-page-title]")!.textContent).toBe("http://localhost:5173");
    expect($("[data-slot=web-page-domain]")).toBeNull();
  });

  test("takes an Open label, a class and pass-through attributes", async () => {
    await render(<WebLinkCard url="http://localhost:5173/" openLabel="Read" className="extra" id="card" data-turn="7" />);
    const card = $("[data-slot=web-link-card]")!;
    expect([card.id, card.dataset.turn]).toEqual(["card", "7"]);
    expect(card.className.split(" ")).toEqual(expect.arrayContaining(["sui-web-link-card", "extra"]));
    const link = $("a")!;
    expect([link.textContent, link.getAttribute("aria-label")]).toEqual(["Read↵", "Read: localhost:5173"]);
  });

  test("calls onOpen once per click and leaves the click to open the tab", async () => {
    const onOpen = mock(() => {});
    await render(<WebLinkCard url="https://example.com/" onOpen={onOpen} />);
    expect(onOpen).toHaveBeenCalledTimes(0);
    expect(await defaultPreventedBeforeHost($("a")!)).toBe(false);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(await defaultPreventedBeforeHost($("a")!)).toBe(false);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  test("opens the tab with no onOpen", async () => {
    await render(<WebLinkCard url="https://example.com/" />);
    expect(await defaultPreventedBeforeHost($("a")!)).toBe(false);
  });

  test("a caller cannot replace the root's slot", async () => {
    await render(<WebLinkCard url="https://example.com/" {...({ "data-slot": "other" } as Record<string, string>)} />);
    expect($("section")!.dataset.slot).toBe("web-link-card");
  });

  describe("refuses, with no link", () => {
    const refused: ReadonlyArray<readonly [string, string]> = [
      ["javascript:", "javascript:alert(1)"],
      ["javascript: split by a newline", "java\nscript:alert(1)"],
      ["data:", "data:text/html,hi"],
      ["file:", "file:///etc/passwd"],
      ["blob:", "blob:https://example.com/0b1c2d3e"],
      ["about:blank", "about:blank"],
      ["a relative path", "docs/page"],
      ["a protocol-relative URL", "//evil.example/"],
      ["credentials", "https://maya@example.com/"],
    ];
    for (const [name, url] of refused) {
      test(name, async () => {
        await render(<WebLinkCard url={url} className="extra" id="card" />);
        expect(container!.querySelectorAll("a, [href], iframe")).toHaveLength(0);
        const empty = $("[data-slot=web-link-card]")!;
        expect(empty.dataset.refused).toBe("true");
        expect(empty.textContent).toBe("Can't show this page");
        expect([empty.id, empty.className]).toEqual(["card", "sui-empty extra"]);
      });
    }

    test("the host's own origin, but not the rest of its site", async () => {
      happyDOM.setURL("https://app.smithers.sh/chat/1");
      await render(<WebLinkCard url="https://app.smithers.sh/settings" />);
      expect(container!.querySelectorAll("a")).toHaveLength(0);
      expect($("[data-slot=web-link-card]")!.dataset.refused).toBe("true");
      // A link opens a separate tab, so another origin on the host's site is fine.
      await act(async () => root!.render(<WebLinkCard url="https://docs.smithers.sh/" />));
      expect($("a")!.getAttribute("href")).toBe("https://docs.smithers.sh/");
    });
  });
});
