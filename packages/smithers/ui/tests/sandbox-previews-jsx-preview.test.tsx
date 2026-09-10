/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSXPreview } from "../src/sandbox/JSXPreview";
import { sandboxCss } from "../src/sandbox/sandboxCss";
import { SMITHERS_UI_STYLE_ATTR } from "../src/styles";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  delete document.documentElement.dataset.theme;
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((element) => element.remove());
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const current = root;
  await act(async () => current.render(element));
}

describe("JSXPreview", () => {
  test("renders the provided node verbatim inside an inert frame", async () => {
    await render(<JSXPreview node={<button type="button">Inside</button>} />);
    const frame = container!.querySelector('[data-slot="jsx-preview-frame"]')!;
    expect(frame.getAttribute("inert")).not.toBeNull();
    expect(frame.querySelector("button")?.textContent).toBe("Inside");
  });

  test("inert can be disabled explicitly", async () => {
    await render(<JSXPreview node={<span>Live</span>} inert={false} />);
    expect(container!.querySelector('[data-slot="jsx-preview-frame"]')?.getAttribute("inert")).toBeNull();
  });

  test("no node renders an honest unavailable state, never synthesized output", async () => {
    await render(<JSXPreview />);
    expect(container!.querySelector('[data-slot="jsx-preview-frame"]')).toBeNull();
    expect(container!.querySelector('[data-slot="empty-state"]')?.textContent).toContain("Preview unavailable");
  });

  test("unavailableReason overrides the default empty-state copy", async () => {
    await render(<JSXPreview unavailableReason="Renderer not connected" />);
    expect(container!.querySelector('[data-slot="empty-state"]')?.textContent).toContain("Renderer not connected");
  });

  test("renders under the dark theme with the lane stylesheet injected", async () => {
    document.documentElement.dataset.theme = "dark";
    await render(<JSXPreview node={<span>Dark</span>} />);
    expect(container!.querySelector('[data-slot="jsx-preview"]')).not.toBeNull();
    expect(document.querySelector(`style[${SMITHERS_UI_STYLE_ATTR}]`)?.textContent).toContain(sandboxCss.trim());
  });
});
