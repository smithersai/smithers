/** @jsxImportSource react */
// Under `asChild`, a disabled or loading Button must make the slotted element
// inert. Anchors ignore the `disabled` attribute, so without a capture-phase
// guard a loading link still ran its onClick and navigated.
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Button } from "../src/button";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
});

async function renderLink(element: ReactElement): Promise<HTMLAnchorElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const mounted = root;
  await act(async () => mounted.render(element));
  const link = container.querySelector("a");
  if (!link) throw new Error("no slotted anchor");
  return link;
}

async function dispatch(target: HTMLElement, event: Event): Promise<Event> {
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

const click = () => new MouseEvent("click", { bubbles: true, cancelable: true });
const key = (k: string) => new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });

describe("Button asChild activation", () => {
  for (const state of ["loading", "disabled"] as const) {
    test(`${state} slotted link ignores click, Enter, and Space`, async () => {
      const onClick = mock(() => {});
      const onKeyDown = mock(() => {});
      const link = await renderLink(
        <Button asChild loading={state === "loading"} disabled={state === "disabled"}>
          <a href="/runs" onClick={onClick} onKeyDown={onKeyDown}>
            Open runs
          </a>
        </Button>,
      );
      expect(link.getAttribute("aria-disabled")).toBe("true");

      expect((await dispatch(link, click())).defaultPrevented).toBe(true);
      expect((await dispatch(link, key("Enter"))).defaultPrevented).toBe(true);
      expect((await dispatch(link, key(" "))).defaultPrevented).toBe(true);
      expect(onClick).not.toHaveBeenCalled();
      expect(onKeyDown).not.toHaveBeenCalled();

      // Tab still reaches the element and its handler, so it stays focusable.
      expect((await dispatch(link, key("Tab"))).defaultPrevented).toBe(false);
      expect(onKeyDown).toHaveBeenCalledTimes(1);
    });
  }

  test("enabled slotted link runs its click handler", async () => {
    const onClick = mock(() => {});
    const link = await renderLink(
      <Button asChild>
        <a href="/runs" onClick={(event) => { event.preventDefault(); onClick(); }}>
          Open runs
        </a>
      </Button>,
    );
    expect(link.hasAttribute("aria-disabled")).toBe(false);
    await dispatch(link, click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
