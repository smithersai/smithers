/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InlineCitation, SMITHERS_UI_STYLE_ATTR } from "../src/index";

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
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((element) => element.remove());
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const current = root;
  await act(async () => current.render(element));
}

describe("InlineCitation", () => {
  test("renders unsafe or absent hrefs as focusable buttons with exact accessible names", async () => {
    await render(<InlineCitation index={3} label="Safety report" href="javascript:alert(1)" />);
    const trigger = container!.querySelector('[data-slot="tooltip-trigger"]') as HTMLButtonElement;

    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.type).toBe("button");
    expect(trigger.textContent).toBe("[3]");
    expect(trigger.getAttribute("aria-label")).toBe("Source 3: Safety report");
    expect(container!.querySelector("a")).toBeNull();
  });

  test("shows the source label tooltip on keyboard focus", async () => {
    await render(<InlineCitation index={3} label="Keyboard source" />);
    const trigger = container!.querySelector('[data-slot="tooltip-trigger"]') as HTMLButtonElement;

    await act(async () => {
      trigger.focus();
      await Promise.resolve();
    });

    const tooltip = document.querySelector('[data-slot="tooltip-content"]');
    expect(tooltip).not.toBeNull();
    expect(tooltip!.textContent).toContain("Keyboard source");
  });

  test("passes only sanitized hrefs with default navigation prevented", async () => {
    const navigated: Array<{ href: string; prevented: boolean }> = [];
    await render(
      <InlineCitation
        index={2}
        label="Docs"
        href=" /docs/reference "
        onNavigate={(href, event) => navigated.push({ href, prevented: event.defaultPrevented })}
      />,
    );
    const link = container!.querySelector('[data-slot="tooltip-trigger"]') as HTMLAnchorElement;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => link.dispatchEvent(event));

    expect(link.getAttribute("href")).toBe("/docs/reference");
    expect(navigated).toEqual([{ href: "/docs/reference", prevented: true }]);
  });
});
