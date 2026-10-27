/** @jsxImportSource react */
// The read-only document view on the real Milkdown Crepe editor, as RepoView shows a README: an HTML node in the
// Markdown shows as its text, never as markup.
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
  document.querySelectorAll(`style[${MARKDOWN_EDITOR_STYLE_ATTR}]`).forEach((element) => element.remove());
});

test("a read-only document renders sanitized inline and block HTML", async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  const created = createRoot(container);
  root = created;
  const document_ = "Some <b>bold</b> words.\n\n<div onclick=\"alert(1)\">block</div>\n";
  await act(async () => created.render(<MarkdownEditor value={document_} readOnly aria-label="README" fallback={false} />));
  const deadline = Date.now() + 10_000;
  let content: HTMLElement | null = null;
  while ((content = container.querySelector<HTMLElement>('.ProseMirror[aria-label="README"]')) === null) {
    if (Date.now() > deadline) throw new Error("the real editor never became ready");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  expect(content.getAttribute("aria-readonly")).toBe("true");
  expect(content.querySelector("b")?.textContent).toBe("bold");
  expect(content.querySelector("[onclick]")).toBeNull();
  expect(content.textContent).not.toContain("<b>");
  expect(content.querySelector(".sui-markdown-html div")?.textContent).toBe("block");
});
