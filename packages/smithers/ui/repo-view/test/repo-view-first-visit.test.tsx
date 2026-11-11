/** @jsxImportSource react */
// RepoView's repository page as GitHub lays it out, and an HTML file as CodePen shows it, under happy-dom: the about
// panel beside the listing with no tree, folders known without their files, a file's badges, and Code, Preview and
// Split for an HTML file, whose preview is a sandboxed guard frame around the page's own sandboxed frame. What the
// browser does with a page that reaches for the network or navigates is browser/html-preview.browser.test.tsx's.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  disposeCodeViewPool,
  guardDocument,
  HTML_PREVIEW_CSP,
  HTML_PREVIEW_SANDBOX,
  HtmlPreview,
  previewDocument,
  RepoView,
  type RepoViewFile,
  type RepoViewHtmlMode,
  type RepoViewLocation,
  REPO_VIEW_STYLE_ATTR,
} from "../src/index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => disposeCodeViewPool());

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  document.querySelectorAll(`style[${REPO_VIEW_STYLE_ATTR}]`).forEach((el) => el.remove());
});

async function render(element: ReactElement): Promise<void> {
  if (root) {
    const mounted = root;
    await act(async () => mounted.render(element));
    return;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const mounted = root;
  await act(async () => mounted.render(element));
}

const q = <E extends Element = HTMLElement>(selector: string) => container!.querySelector<E>(selector);
const all = (selector: string) => [...container!.querySelectorAll<HTMLElement>(selector)];
const href = (location: RepoViewLocation) => `#/${location.kind}/${location.path}`;
const text = (contents: string): RepoViewFile => ({ state: "text", contents, size: contents.length });

describe("the repository page", () => {
  test("no tree on the left, the about panel on the right, and folders GitHub listed without their files", async () => {
    const moves: Array<RepoViewLocation> = [];
    await render(
      <RepoView
        name="Spoon-Knife"
        tree={{ state: "ready", paths: ["README.md", "index.html"], directories: ["docs", "lib/vendor"] }}
        location={{ kind: "tree", path: "" }}
        href={href}
        onNavigate={(next) => moves.push(next)}
        fileTree={false}
        aside={<p data-testid="about">About</p>}
      />,
    );
    const section = q('[data-slot="repo-view"]')!;
    expect(section.getAttribute("data-tree")).toBe("false");
    expect(section.getAttribute("data-aside")).toBe("true");
    expect(q('aside[aria-label="Files"]')).toBeNull();
    expect(q('[data-testid="about"]')!.parentElement!.className).toBe("sui-repo-aside");
    const listing = all('[data-slot="directory-listing"] a').map((el) => [el.textContent, el.getAttribute("href")]);
    expect(listing).toEqual([
      ["docs", "#/tree/docs"],
      ["lib", "#/tree/lib"],
      ["index.html", "#/blob/index.html"],
      ["README.md", "#/blob/README.md"],
    ]);
  });

  test("a folder known only by name opens as a folder, and an inline view never draws the panel", async () => {
    await render(
      <RepoView
        name="Spoon-Knife"
        tree={{ state: "ready", paths: [], directories: ["docs"] }}
        location={{ kind: "tree", path: "docs" }}
        href={href}
        onNavigate={() => undefined}
        aside={<p data-testid="about">About</p>}
      />,
    );
    // Known, though nothing under it is listed: not "Not found".
    expect(container!.textContent).not.toContain("Not found");
    expect(q('[data-slot="repo-view"]')!.getAttribute("data-tree")).toBe("true");
    await render(
      <RepoView
        name="Spoon-Knife"
        size="inline"
        tree={{ state: "ready", paths: ["a.md"] }}
        location={{ kind: "tree", path: "" }}
        href={href}
        onNavigate={() => undefined}
        aside={<p data-testid="about">About</p>}
      />,
    );
    expect(q('[data-testid="about"]')).toBeNull();
    expect(q('[data-slot="repo-view"]')!.getAttribute("data-aside")).toBe("false");
  });

  test("a file's badges sit after its stats in the toolbar", async () => {
    await render(
      <RepoView
        name="r"
        tree={{ state: "ready", paths: ["gen.ts"] }}
        location={{ kind: "blob", path: "gen.ts" }}
        file={text("// @generated\n")}
        href={href}
        onNavigate={() => undefined}
        fileBadges={<span data-testid="badge">Generated</span>}
      />,
    );
    const badges = q('[data-testid="badge"]')!.parentElement!;
    expect(badges.className).toBe("sui-repo-file-badges");
    expect(badges.previousElementSibling!.className).toBe("sui-repo-stats");
  });
});

describe("an HTML file, as CodePen shows it", () => {
  const PAGE = "<!DOCTYPE html>\n<html><body><h1>Fork me</h1><script>fetch('https://evil.test')</script></body></html>\n";

  const page = async (props: { htmlMode?: RepoViewHtmlMode; onHtmlModeChange?: (mode: RepoViewHtmlMode) => void } = {}) =>
    render(
      <RepoView
        name="Spoon-Knife"
        tree={{ state: "ready", paths: ["index.html"] }}
        location={{ kind: "blob", path: "index.html" }}
        file={text(PAGE)}
        href={href}
        onNavigate={() => undefined}
        {...props}
      />,
    );

  const pressed = () => all(".sui-repo-segment").map((el) => [el.textContent, el.getAttribute("aria-pressed")]);
  const press = async (label: string) =>
    act(async () => all(".sui-repo-segment").find((el) => el.textContent === label)!.click());

  test("opens as code; Preview shows the page alone, Split shows both, Code goes back", async () => {
    await page();
    expect(pressed()).toEqual([["Code", "true"], ["Preview", "false"], ["Split", "false"]]);
    expect(q("iframe")).toBeNull();
    expect(q('[data-slot="code-view"], .sui-code-view')).not.toBeNull();
    await press("Preview");
    expect(q("article")!.getAttribute("data-html-mode")).toBe("preview");
    const frame = q<HTMLIFrameElement>("iframe")!;
    expect(frame.getAttribute("title")).toBe("Preview of index.html");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(q(".sui-code-view")).toBeNull();
    await press("Split");
    expect(q(".sui-repo-html-split iframe")).not.toBeNull();
    expect(q(".sui-repo-html-split .sui-code-view")).not.toBeNull();
    await press("Code");
    expect(q("iframe")).toBeNull();
  });

  test("a controlled mode follows its host, and each press reports the mode", async () => {
    const asked: Array<RepoViewHtmlMode> = [];
    await page({ htmlMode: "split", onHtmlModeChange: (mode) => asked.push(mode) });
    expect(pressed()).toEqual([["Code", "false"], ["Preview", "false"], ["Split", "true"]]);
    await press("Preview");
    expect(asked).toEqual(["preview"]);
    // The host still says split.
    expect(q(".sui-repo-html-split")).not.toBeNull();
  });

  test("a file that isn't HTML, or isn't text, offers no modes", async () => {
    await render(
      <RepoView
        name="r"
        tree={{ state: "ready", paths: ["a.ts", "b.html"] }}
        location={{ kind: "blob", path: "a.ts" }}
        file={text("export {}\n")}
        href={href}
        onNavigate={() => undefined}
      />,
    );
    expect(all(".sui-repo-segment")).toEqual([]);
    expect(q("article")!.hasAttribute("data-html-mode")).toBe(false);
    await render(
      <RepoView
        name="r"
        tree={{ state: "ready", paths: ["a.ts", "b.html"] }}
        location={{ kind: "blob", path: "b.html" }}
        file={{ state: "loading" }}
        href={href}
        onNavigate={() => undefined}
      />,
    );
    expect(all(".sui-repo-segment")).toEqual([]);
  });
});

describe("HtmlPreview", () => {
  test("the page behind a policy that admits only inline script and style, with links that can't leave", () => {
    const document = previewDocument("﻿  <!doctype html><html><head><title>t</title></head><body>x</body></html>");
    expect(document.startsWith(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}"><base target="_blank">`)).toBe(true);
    // The file's own doctype gives way to the one ahead of the policy.
    expect(document.match(/<!doctype/gi)).toHaveLength(1);
    expect(document.endsWith("<html><head><title>t</title></head><body>x</body></html>")).toBe(true);
    expect(HTML_PREVIEW_CSP).toContain("connect-src 'none'");
    expect(HTML_PREVIEW_CSP).toContain("default-src 'none'");
    expect(HTML_PREVIEW_CSP).toContain("form-action 'none'");
    expect(HTML_PREVIEW_CSP).not.toContain("http");
    expect(HTML_PREVIEW_SANDBOX).toBe("allow-scripts");
    expect(previewDocument("<p>bare</p>").endsWith("<base target=\"_blank\"><p>bare</p>")).toBe(true);
  });

  test("the guard: the page's own sandboxed frame under the same policy, and a hidden note", () => {
    const html = `<p title="a&amp;b">x</p>`;
    const title = `Preview of "<x>".html`;
    const guard = new DOMParser().parseFromString(guardDocument(html, title), "text/html");
    // A srcdoc document inherits its parent's policy, and its navigations answer to the parent's frame-src.
    expect(guard.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute("content")).toBe(HTML_PREVIEW_CSP);
    expect(HTML_PREVIEW_CSP).toContain("frame-src 'none'");
    const frame = guard.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe(HTML_PREVIEW_SANDBOX);
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("title")).toBe(title);
    // The page reaches its frame unchanged, quotes, ampersands and angle brackets included.
    expect(frame.getAttribute("srcdoc")).toBe(previewDocument(html));
    expect(guard.querySelector("p")!.hidden).toBe(true);
    expect(guard.querySelector("script")!.textContent).toContain("securitypolicyviolation");
  });

  test("HtmlPreview's frame holds the guard and reports its one load", async () => {
    const loads: Array<string> = [];
    await render(<HtmlPreview html="<p>x</p>" title="Preview" onLoad={() => loads.push("load")} />);
    const frame = q<HTMLIFrameElement>("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe(HTML_PREVIEW_SANDBOX);
    expect(frame.getAttribute("srcdoc")).toBe(guardDocument("<p>x</p>", "Preview"));
    expect(loads).toEqual(["load"]);
  });
});
