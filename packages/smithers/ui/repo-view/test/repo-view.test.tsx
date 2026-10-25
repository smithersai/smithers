/** @jsxImportSource react */
// RepoView under happy-dom: the real FileTree, Breadcrumbs, DirectoryListing, CodeFileView (@pierre/diffs) and
// MarkdownEditor. happy-dom computes no layout, so Markdown renders as the editor's textarea unless a test drives the
// WYSIWYG path through the editor's own `loadEditor` seam, with a stand-in for Crepe that renders the document's
// links. Clicks are native MouseEvents, so modifier keys and default-prevented flags are the browser's own.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  disposeCodeViewPool,
  type MarkdownEditorModule,
  RepoView,
  type RepoViewFile,
  type RepoViewLocation,
  type RepoViewProps,
  type RepoViewTree,
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

async function click(el: Element, init: MouseEventInit = {}): Promise<boolean> {
  let followed = true;
  await act(async () => {
    followed = el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }));
  });
  return followed;
}

const PATHS = [
  "src/router.ts",
  "README.md",
  "src/middleware/json.ts",
  "docs/guide.md",
  "LICENSE",
  "assets/logo.png",
];
const READY: RepoViewTree = { state: "ready", paths: PATHS };
const href = (location: RepoViewLocation) => `#/${location.kind}/${location.path}`;
const text = (contents: string): RepoViewFile => ({ state: "text", contents, size: new TextEncoder().encode(contents).length });

/** A view with the navigation it was asked for recorded. */
const view = (props: Partial<RepoViewProps> & { location: RepoViewLocation }) => {
  const moves: Array<RepoViewLocation> = [];
  const element = (extra: Partial<RepoViewProps> = {}) => (
    <RepoView name="tinyhttp" tree={READY} href={href} onNavigate={(next) => moves.push(next)} {...props} {...extra} />
  );
  return { moves, element };
};

const q = <E extends Element = HTMLElement>(selector: string) => container!.querySelector<E>(selector);
const all = (selector: string) => [...container!.querySelectorAll<HTMLElement>(selector)];
const treeFiles = () => all('[data-slot="file-tree-file"]').map((el) => el.textContent);
const treeDirs = () =>
  all('[data-slot="file-tree-dir-toggle"]').map((el) => [el.textContent, el.getAttribute("aria-expanded")]);

/** A stand-in for Crepe that renders the document's links, so the editor's link handling is real. */
const crepeWithLinks = (hrefs: ReadonlyArray<string>): (() => Promise<MarkdownEditorModule>) => async () => ({
  Crepe: class {
    readonly editor = { action: () => undefined };
    constructor(readonly options: { root: HTMLElement; defaultValue: string }) {}
    getMarkdown() {
      return this.options.defaultValue;
    }
    async create() {
      for (const link of hrefs) {
        const anchor = document.createElement("a");
        anchor.setAttribute("href", link);
        anchor.textContent = link;
        this.options.root.append(anchor);
      }
    }
    async destroy() {}
    setReadonly() {}
  } as unknown as MarkdownEditorModule["Crepe"],
  replaceAll: (markdown: string) => ({ markdown }),
  listenImmediately: () => {},
});

describe("RepoView", () => {
  test("the root: the tree beside the listing, the path trail, the README, and the host's slots", async () => {
    const { element } = view({
      location: { kind: "tree", path: "" },
      readme: { path: "README.md", file: { state: "loading" } },
      revision: <span data-testid="revision">main</span>,
      actions: <button type="button">Copy permalink</button>,
      summary: <span data-testid="summary">chore: release</span>,
    });
    await render(element());
    const section = q('[data-slot="repo-view"]')!;
    expect(section.getAttribute("data-size")).toBe("full");
    expect(section.getAttribute("aria-label")).toBe("tinyhttp");
    expect(q("aside")!.getAttribute("aria-label")).toBe("Files");
    // Directories first at every level; everything collapsed but the location's ancestors.
    expect(treeDirs()).toEqual([["assets", "false"], ["docs", "false"], ["src", "false"]]);
    expect(treeFiles()).toEqual(["LICENSE", "README.md"]);
    const listing = all('[data-slot="directory-listing"] a').map((el) => [el.textContent, el.getAttribute("href")]);
    expect(listing).toEqual([
      ["assets", "#/tree/assets"],
      ["docs", "#/tree/docs"],
      ["src", "#/tree/src"],
      ["LICENSE", "#/blob/LICENSE"],
      ["README.md", "#/blob/README.md"],
    ]);
    expect(q('[data-slot="directory-listing"] ul')!.getAttribute("aria-label")).toBe("tinyhttp");
    expect(q('[aria-current="page"]')!.textContent).toBe("tinyhttp");
    expect(q('[data-testid="revision"]')!.parentElement!.className).toBe("sui-repo-revision");
    expect(q(".sui-repo-actions button")!.textContent).toBe("Copy permalink");
    expect(q('[data-testid="summary"]')!.parentElement!.className).toBe("sui-repo-summary");
    const readme = q('article[aria-label="README.md"]')!;
    expect(readme.querySelector("a")!.getAttribute("href")).toBe("#/blob/README.md");
    expect(readme.querySelector('[role="status"]')!.getAttribute("aria-label")).toBe("Loading README.md");
    expect(readme.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(3);
    expect(readme.querySelector('[data-slot="spinner"]')).toBeNull();
  });

  test("a README renders as a Markdown document; its name opens it", async () => {
    const { element, moves } = view({
      location: { kind: "tree", path: "" },
      readme: { path: "README.md", file: text("# tinyhttp\n\nA router.\n") },
    });
    await render(element());
    const editor = q<HTMLTextAreaElement>('article[aria-label="README.md"] textarea')!;
    expect(editor.value).toBe("# tinyhttp\n\nA router.\n");
    expect(editor.readOnly).toBe(true);
    expect(await click(q('article[aria-label="README.md"] a')!, { metaKey: true })).toBe(true);
    expect(await click(q('article[aria-label="README.md"] a')!)).toBe(false);
    expect(moves).toEqual([{ kind: "blob", path: "README.md" }]);
  });

  test("navigating opens the location's directories in the tree, and toggles open and close them", async () => {
    const toggles: Array<[string, boolean]> = [];
    const { element, moves } = view({ location: { kind: "tree", path: "" }, onToggle: (path, open) => toggles.push([path, open]) });
    await render(element());
    await click(all('[data-slot="directory-listing"] a').find((el) => el.textContent === "src")!);
    expect(moves).toEqual([{ kind: "tree", path: "src" }]);
    expect(treeDirs()).toContainEqual(["src", "true"]);
    expect(treeDirs()).toContainEqual(["middleware", "false"]);
    await click(all('[data-slot="file-tree-dir-toggle"]').find((el) => el.textContent === "middleware")!);
    expect(treeDirs()).toContainEqual(["middleware", "true"]);
    await click(all('[data-slot="file-tree-dir-toggle"]').find((el) => el.textContent === "src")!);
    expect(treeDirs()).toContainEqual(["src", "false"]);
    expect(toggles).toEqual([["src/middleware", true], ["src", false]]);
    // A file in the tree opens it, and opening a nested file opens its directories.
    await click(all('[data-slot="file-tree-file"]').find((el) => el.textContent === "LICENSE")!);
    await click(all('[data-slot="directory-listing"] a').find((el) => el.textContent === "README.md")!);
    expect(moves.slice(1)).toEqual([{ kind: "blob", path: "LICENSE" }, { kind: "blob", path: "README.md" }]);
  });

  test("a host that controls the open directories decides what shows", async () => {
    const { element, moves } = view({ location: { kind: "blob", path: "src/middleware/json.ts" }, expanded: new Set(["docs"]) });
    await render(element({ file: { state: "loading" } }));
    expect(treeDirs()).toEqual([["assets", "false"], ["docs", "true"], ["src", "false"]]);
    await click(all('[data-slot="file-tree-dir-toggle"]').find((el) => el.textContent === "src")!);
    expect(treeDirs()).toContainEqual(["src", "false"]);
    expect(moves).toEqual([]);
  });

  test("a deep location starts with its directories open, and its trail steps to each directory", async () => {
    const { element, moves } = view({ location: { kind: "blob", path: "src/middleware/json.ts" }, file: text("export {}\n") });
    await render(element());
    expect(treeDirs()).toEqual([["assets", "false"], ["docs", "false"], ["src", "true"], ["middleware", "true"]]);
    expect(q('[data-slot="file-tree-file"][data-active="true"]')!.textContent).toBe("json.ts");
    const trail = all(".sui-repo-trail a").map((el) => [el.textContent, el.getAttribute("href")]);
    expect(trail).toEqual([["tinyhttp", "#/tree/"], ["src", "#/tree/src"], ["middleware", "#/tree/src/middleware"]]);
    expect(q('.sui-repo-trail [aria-current="page"]')!.textContent).toBe("json.ts");
    await click(all(".sui-repo-trail a")[1]!);
    expect(moves).toEqual([{ kind: "tree", path: "src" }]);
  });

  test("a directory lists its entries under a parent row", async () => {
    const { element, moves } = view({ location: { kind: "tree", path: "src/middleware" } });
    await render(element());
    const rows = all('[data-slot="directory-listing"] a');
    expect(rows.map((el) => el.textContent)).toEqual(["..", "json.ts"]);
    expect(q('[data-slot="directory-listing"] ul')!.getAttribute("aria-label")).toBe("src/middleware");
    await click(rows[0]!);
    expect(moves).toEqual([{ kind: "tree", path: "src" }]);
    expect(rows[0]!.getAttribute("href")).toBe("#/tree/src");
  });

  test("a code file shows its lines and size, highlighted, anchored at its range", async () => {
    const contents = "export const a = 1\nexport const b = 2\nexport const c = 3\n";
    const { element } = view({
      location: { kind: "blob", path: "src/router.ts", line: 2, lineEnd: 3 },
      file: text(contents),
      fileActions: <a href="#raw">Raw</a>,
    });
    await render(element());
    const file = q('article[aria-label="src/router.ts"]')!;
    expect(file.querySelector(".sui-repo-stats")!.textContent).toBe("3 lines · 57 B");
    expect(file.querySelector(".sui-repo-file-actions a")!.textContent).toBe("Raw");
    expect(file.querySelector(".sui-repo-segmented")).toBeNull();
    const code = file.querySelector('[data-slot="code-view"]')!;
    expect(code.getAttribute("data-language")).toBe("typescript");
    expect(code.querySelector(".sui-code-view-plain")!.textContent).toBe(contents);
  });

  test("a Markdown file switches between the document and its source, uncontrolled or controlled", async () => {
    const modes: Array<string> = [];
    const { element } = view({
      location: { kind: "blob", path: "docs/guide.md" },
      file: text("# Guide\n"),
      onMarkdownModeChange: (mode) => modes.push(mode),
    });
    await render(element());
    const buttons = () => all(".sui-repo-segment");
    expect(buttons().map((el) => [el.textContent, el.getAttribute("aria-pressed")])).toEqual([
      ["Preview", "true"],
      ["Code", "false"],
    ]);
    expect(q("textarea")).not.toBeNull();
    await click(buttons()[1]!);
    expect(q("textarea")).toBeNull();
    expect(q('[data-slot="code-view"]')!.getAttribute("data-language")).toBe("markdown");
    expect(modes).toEqual(["source"]);
    await render(element({ markdownMode: "preview" }));
    expect(q("textarea")).not.toBeNull();
    await click(buttons()[1]!);
    expect(q("textarea")).not.toBeNull();
    expect(modes).toEqual(["source", "source"]);
  });

  test("a host's Markdown preview takes the read-only document's place in preview mode only, an empty file's too", async () => {
    const editor = <div data-testid="live-editor" contentEditable suppressContentEditableWarning>live</div>;
    const { element } = view({ location: { kind: "blob", path: "docs/guide.md" }, file: text("# Guide\n"), markdownPreview: editor });
    await render(element());
    expect(q('[data-testid="live-editor"]')!.getAttribute("contenteditable")).toBe("true");
    expect(q("textarea")).toBeNull();
    expect(q(".sui-markdown-editor")).toBeNull();
    // Code still shows the source.
    await click(all(".sui-repo-segment")[1]!);
    expect(q('[data-testid="live-editor"]')).toBeNull();
    expect(q('[data-slot="code-view"]')!.getAttribute("data-language")).toBe("markdown");
    // An empty file is the editor too, where a document would say Empty file.
    await render(element({ markdownMode: "preview", file: text("") }));
    expect(q('[data-testid="live-editor"]')).not.toBeNull();
    expect(q(".sui-repo-note")).toBeNull();
    // A file that hasn't loaded shows its skeleton, and absent or null the read-only document shows.
    await render(element({ markdownMode: "preview", file: { state: "loading" } }));
    expect(q('[data-testid="live-editor"]')).toBeNull();
    await render(element({ markdownMode: "preview", markdownPreview: null }));
    expect(q('[data-testid="live-editor"]')).toBeNull();
    expect(q("textarea")!.readOnly).toBe(true);
    // Code files and a directory's README never take it.
    await render(element({ location: { kind: "blob", path: "src/router.ts" }, file: text("export {}\n") }));
    expect(q('[data-testid="live-editor"]')).toBeNull();
    await render(element({
      location: { kind: "tree", path: "" },
      file: undefined,
      readme: { path: "README.md", file: text("# tinyhttp\n") },
    }));
    expect(q('[data-testid="live-editor"]')).toBeNull();
    expect(q('article[aria-label="README.md"] textarea')).not.toBeNull();
  });

  test("a document's relative links open in the view; the browser keeps the rest", async () => {
    const { element, moves } = view({
      location: { kind: "blob", path: "docs/guide.md" },
      file: text("# Guide\n"),
      markdownEditor: { fallback: false, loadEditor: crepeWithLinks(["../src/router.ts", "https://example.com", "../src/"]) },
    });
    await render(element());
    await act(async () => {
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    });
    const links = all(".sui-markdown-editor a");
    expect(links.map((el) => el.getAttribute("href"))).toEqual(["../src/router.ts", "https://example.com", "../src/"]);
    expect(await click(links[0]!)).toBe(false);
    expect(await click(links[1]!)).toBe(true);
    expect(await click(links[2]!)).toBe(false);
    expect(moves).toEqual([{ kind: "blob", path: "src/router.ts" }, { kind: "tree", path: "src" }]);
  });

  test("each file state: loading, binary, too large, empty and failed", async () => {
    const { element } = view({ location: { kind: "blob", path: "assets/logo.png" } });
    await render(element());
    expect(q('article [role="status"]')!.getAttribute("aria-label")).toBe("Loading assets/logo.png");
    expect(q('article [data-slot="skeleton"]')).not.toBeNull();
    expect(q('[data-slot="spinner"]')).toBeNull();
    expect(q(".sui-repo-stats")).toBeNull();
    await render(element({ file: { state: "binary", size: 2048 } }));
    expect(q("article .sui-repo-note")!.textContent).toBe("Binary file");
    expect(q(".sui-repo-stats")!.textContent).toBe("2.0 KB");
    await render(element({ file: { state: "too-large", size: 3 * 1024 * 1024 } }));
    expect(q("article .sui-repo-note")!.textContent).toBe("Too large to show");
    expect(q(".sui-repo-stats")!.textContent).toBe("3.0 MB");
    await render(element({ file: text("") }));
    expect(q("article .sui-repo-note")!.textContent).toBe("Empty file");
    expect(q(".sui-repo-stats")!.textContent).toBe("0 lines · 0 B");
    await render(element({ file: { state: "failed", message: "Couldn't load this file." } }));
    expect(q('article [role="alert"]')!.textContent).toBe("Couldn't load this file.");
  });

  test("the tree loading, failed, truncated and empty; a location that isn't there", async () => {
    const { element } = view({ location: { kind: "tree", path: "" }, tree: { state: "loading" } });
    await render(element());
    expect(q('.sui-repo-content [role="status"]')!.getAttribute("aria-label")).toBe("Loading files");
    expect(q(".sui-repo-content .sui-repo-box.sui-repo-loading")!.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(4);
    expect(q('[data-slot="spinner"]')).toBeNull();
    // The tree's column holds its place, empty, so the content sits in its own column and never jumps when the
    // files arrive (a loading view used to draw its content in the tree's 240 px column).
    expect(q('aside[aria-label="Files"]')!.childElementCount).toBe(0);
    expect(q('aside[aria-label="Files"]')!.nextElementSibling!.className).toBe("sui-repo-main");
    await render(element({ tree: { state: "failed", message: "Couldn't list the files." } }));
    expect(q('.sui-repo-content [role="alert"]')!.textContent).toBe("Couldn't list the files.");
    await render(element({ tree: { state: "ready", paths: PATHS, truncated: true } }));
    expect(q("aside .sui-repo-note")!.textContent).toBe("More files not shown");
    await render(element({ tree: { state: "ready", paths: [] } }));
    expect(q('[data-slot="directory-listing"]')!.textContent).toBe("Empty repository");
    await render(element({ tree: READY, location: { kind: "tree", path: "nope" } }));
    expect(q(".sui-repo-content .sui-repo-note")!.textContent).toBe("Not found");
    await render(element({ tree: READY, location: { kind: "blob", path: "src" } }));
    expect(q(".sui-repo-content .sui-repo-note")!.textContent).toBe("Not found");
  });

  test("inline: no tree, the same content", async () => {
    const { element } = view({ location: { kind: "tree", path: "src" }, size: "inline" });
    await render(element());
    expect(q('[data-slot="repo-view"]')!.getAttribute("data-size")).toBe("inline");
    expect(q("aside")).toBeNull();
    expect(all('[data-slot="directory-listing"] a').map((el) => el.textContent)).toEqual(["..", "middleware", "router.ts"]);
  });
});
