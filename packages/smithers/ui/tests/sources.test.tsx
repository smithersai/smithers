/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SMITHERS_UI_STYLE_ATTR, Sources } from "../src/index";

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

async function nativeKeyboardActivate(button: HTMLButtonElement, key: "Enter" | " "): Promise<void> {
  await act(async () => {
    button.focus();
    button.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    button.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
    button.click();
  });
}

describe("Sources", () => {
  test("renders singular and plural frozen header labels", async () => {
    await render(<Sources sources={[{ id: "one", label: "One" }]} />);
    expect(container!.querySelector('[data-slot="sources-trigger"]')?.textContent).toContain("Used 1 source");

    await act(async () =>
      root!.render(
        <Sources
          sources={[
            { id: "one", label: "One" },
            { id: "two", label: "Two" },
          ]}
        />,
      ),
    );
    expect(container!.querySelector('[data-slot="sources-trigger"]')?.textContent).toContain("Used 2 sources");
  });

  test("uses a native keyboard-operable disclosure and unmounts the list", async () => {
    await render(<Sources sources={[{ id: "one", label: "One" }]} />);
    const trigger = container!.querySelector('[data-slot="sources-trigger"]') as HTMLButtonElement;

    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.type).toBe("button");
    expect(container!.querySelector('[data-slot="sources-list"]')).toBeNull();
    await nativeKeyboardActivate(trigger, "Enter");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(container!.querySelector('[data-slot="sources-list"]')).not.toBeNull();
    await nativeKeyboardActivate(trigger, " ");
    expect(container!.querySelector('[data-slot="sources-list"]')).toBeNull();
  });

  test("renders unsafe hrefs as plain text and never navigates", async () => {
    const navigated: string[] = [];
    await render(
      <Sources
        defaultOpen
        sources={[{ id: "bad", label: "Unsafe", href: "javascript:alert(1)" }]}
        onNavigate={(href) => navigated.push(href)}
      />,
    );

    expect(container!.querySelector(".sui-sources-link")).toBeNull();
    expect(container!.querySelector(".sui-sources-label")?.textContent).toBe("Unsafe");
    expect(navigated).toEqual([]);
  });

  test("passes a sanitized href and prevented event to onNavigate", async () => {
    const navigated: Array<{ href: string; prevented: boolean }> = [];
    await render(
      <Sources
        defaultOpen
        sources={[{ id: "safe", label: "Docs", href: "  https://smithers.sh/docs  " }]}
        onNavigate={(href, event) => navigated.push({ href, prevented: event.defaultPrevented })}
      />,
    );
    const link = container!.querySelector(".sui-sources-link") as HTMLAnchorElement;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => link.dispatchEvent(event));

    expect(link.getAttribute("href")).toBe("https://smithers.sh/docs");
    expect(navigated).toEqual([{ href: "https://smithers.sh/docs", prevented: true }]);
    expect(event.defaultPrevented).toBe(true);
  });

});
