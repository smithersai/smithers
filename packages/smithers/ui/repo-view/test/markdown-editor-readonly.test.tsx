/** @jsxImportSource react */
// All previews below mount the real Crepe editor.
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MARKDOWN_EDITOR_STYLE_ATTR, MarkdownEditor } from "../src/index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  const mounted = root;
  if (mounted) await act(async () => mounted.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  document.querySelectorAll(`style[${MARKDOWN_EDITOR_STYLE_ATTR}]`).forEach(element => element.remove());
});

async function mount(source: string): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const created = root;
  let failure: unknown;
  await act(async () => created.render(<MarkdownEditor value={source} readOnly aria-label="README" fallback={false} onError={error => { failure = error.cause; }} />));
  const deadline = Date.now() + 4_000;
  for (;;) {
    if (failure) throw failure;
    const content = container.querySelector<HTMLElement>('.ProseMirror[aria-label="README"]');
    if (content) return content;
    if (Date.now() > deadline) throw new Error("the real editor never became ready");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
}

test("read-only HTML renders safe emphasis and centered pre, hiding comments and scripts", async () => {
  const content = await mount('<!-- generated -->\n\n<pre align="center"> a  b\n c</pre>\n\nSome <b>bold</b> words.\n\n<div onclick="alert(1)">block</div>\n\n<script>document.title="bad"</script>\n<style>body{display:none}</style>');
  expect(content.getAttribute("aria-readonly")).toBe("true");
  expect(content.querySelector("b")?.textContent).toBe("bold");
  expect(content.querySelector("pre")?.textContent).toBe(" a  b\n c");
  expect(content.querySelector("pre")?.style.textAlign).toBe("center");
  expect(content.querySelector("script,style,[onclick]")).toBeNull();
  expect(content.textContent).not.toContain("generated");
  expect(content.textContent).not.toContain("document.title");
  expect(content.querySelector(".sui-markdown-html div")?.textContent).toBe("block");
});

test("read-only metadata stays out of the heading and body", async () => {
  const content = await mount("---\ntitle: Quickstart\nsidebar:\n  order: 2\n---\n\n# Quickstart");
  expect(content.textContent).not.toContain("title:");
  expect(content.textContent).not.toContain("sidebar:");
  expect(content.querySelector("h1")?.textContent).toBe("Quickstart");
});

test("read-only GitHub warnings have a title and no marker", async () => {
  const content = await mount("> [!WARNING]\n> Danger");
  expect(content.querySelector(".sui-markdown-alert-title")?.textContent).toBe("Warning");
  expect(content.textContent).not.toContain("[!WARNING]");
  expect(content.textContent).toContain("Danger");
});

test("read-only empty badge links have accessible names", async () => {
  const content = await mount("[![](https://example.com/badge.svg)](https://example.com/package)");
  expect(content.querySelector("a")?.getAttribute("aria-label")).toBe("package");
});

