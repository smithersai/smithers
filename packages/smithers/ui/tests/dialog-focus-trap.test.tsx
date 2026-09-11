/** @jsxImportSource react */
// `useDialogFocusTrap` is public API (`src/index.ts`) that no component in this
// package uses -- Dialog is built on Radix -- so it only ever runs in a
// consumer's tree. It had 0% function coverage; this is its suite.
import { afterEach, describe, expect, test } from "bun:test";
import { act, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useDialogFocusTrap } from "../src/internal/useDialogFocusTrap";

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

type DialogProps = {
  active?: boolean;
  onClose?: () => void;
  children: ReactNode;
};

function Dialog({ active = true, onClose = () => {}, children }: DialogProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDialogFocusTrap({ active, containerRef: ref, onClose });
  return (
    <div ref={ref} tabIndex={-1} data-testid="dialog">
      {children}
    </div>
  );
}

async function render(node: ReactNode): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const mounted = root;
  await act(async () => mounted.render(node));
  // The trap focuses on the next frame; let it land.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function press(key: string, options: { shiftKey?: boolean } = {}): void {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, shiftKey: options.shiftKey ?? false }),
  );
}

const active = () => document.activeElement as HTMLElement | null;

describe("useDialogFocusTrap keyboard containment", () => {
  test("Tab wraps from the last control to the first, and shift-Tab back", async () => {
    await render(
      <Dialog>
        <button type="button" data-testid="first">first</button>
        <button type="button" data-testid="last">last</button>
      </Dialog>,
    );
    const first = document.querySelector<HTMLElement>('[data-testid="first"]')!;
    const last = document.querySelector<HTMLElement>('[data-testid="last"]')!;

    await act(async () => last.focus());
    await act(async () => press("Tab"));
    expect(active()).toBe(first);

    await act(async () => press("Tab", { shiftKey: true }));
    expect(active()).toBe(last);
  });

  test("a contenteditable is a tab stop, so Tab out of it wraps instead of escaping", async () => {
    // The bug this pins: `contenteditable` was missing from the focusable
    // selector, so the editor was neither the computed first nor last element
    // and the handler let the browser walk focus out of the dialog.
    await render(
      <Dialog>
        <button type="button" data-testid="first">first</button>
        <div contentEditable suppressContentEditableWarning data-testid="editor">
          rich text
        </div>
      </Dialog>,
    );
    const first = document.querySelector<HTMLElement>('[data-testid="first"]')!;
    const editor = document.querySelector<HTMLElement>('[data-testid="editor"]')!;

    await act(async () => editor.focus());
    let prevented = false;
    document.addEventListener(
      "keydown",
      (event) => {
        prevented = event.defaultPrevented;
      },
      { once: true },
    );
    await act(async () => press("Tab"));
    expect(prevented).toBe(true);
    expect(active()).toBe(first);
  });

  test("an iframe counts as focusable", async () => {
    await render(
      <Dialog>
        <button type="button" data-testid="first">first</button>
        <iframe title="preview" data-testid="frame" />
      </Dialog>,
    );
    const first = document.querySelector<HTMLElement>('[data-testid="first"]')!;
    const frame = document.querySelector<HTMLElement>('[data-testid="frame"]')!;
    await act(async () => frame.focus());
    await act(async () => press("Tab"));
    expect(active()).toBe(first);
  });

  test("focus arriving from outside is pulled back into the dialog", async () => {
    const outside = document.createElement("button");
    outside.type = "button";
    document.body.appendChild(outside);
    try {
      await render(
        <Dialog>
          <button type="button" data-testid="first">first</button>
        </Dialog>,
      );
      const first = document.querySelector<HTMLElement>('[data-testid="first"]')!;
      await act(async () => {
        outside.focus();
        outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(active()).toBe(first);
    } finally {
      outside.remove();
    }
  });

  test("an empty dialog takes focus itself rather than letting Tab out", async () => {
    await render(
      <Dialog>
        <p>nothing focusable here</p>
      </Dialog>,
    );
    const dialog = document.querySelector<HTMLElement>('[data-testid="dialog"]')!;
    await act(async () => press("Tab"));
    expect(active()).toBe(dialog);
  });

  test("a tabindex=-1 or aria-hidden control is never a wrap target", async () => {
    await render(
      <Dialog>
        <button type="button" data-testid="first">first</button>
        <button type="button" data-testid="last">last</button>
        <button type="button" tabIndex={-1} data-testid="skipped">skipped</button>
        <button type="button" aria-hidden="true" data-testid="hidden">hidden</button>
      </Dialog>,
    );
    const first = document.querySelector<HTMLElement>('[data-testid="first"]')!;
    const last = document.querySelector<HTMLElement>('[data-testid="last"]')!;
    await act(async () => last.focus());
    await act(async () => press("Tab"));
    expect(active()).toBe(first);
  });

  test("a control inside an inert subtree is never a wrap target", async () => {
    await render(
      <Dialog>
        <button type="button" data-testid="first">first</button>
        <button type="button" data-testid="last">last</button>
        <div inert>
          <button type="button" data-testid="inert">inert</button>
        </div>
      </Dialog>,
    );
    const first = document.querySelector<HTMLElement>('[data-testid="first"]')!;
    const last = document.querySelector<HTMLElement>('[data-testid="last"]')!;
    await act(async () => last.focus());
    await act(async () => press("Tab"));
    expect(active()).toBe(first);
  });

  test("an unrendered or visibility:hidden control is never the initial focus or a wrap target", async () => {
    // The bug this pins: the filter dropped inert and aria-hidden controls but
    // not unrendered ones, so initial focus and the Tab wrap aimed at a control
    // the browser refuses to focus.
    await render(
      <Dialog>
        <button type="button" style={{ display: "none" }} data-testid="none">none</button>
        <div hidden>
          <button type="button" data-testid="under-hidden">under hidden</button>
        </div>
        <div style={{ display: "none" }}>
          <button type="button" data-testid="under-none">under none</button>
        </div>
        <button type="button" data-testid="first">first</button>
        <button type="button" data-testid="last">last</button>
        <details>
          <summary>more</summary>
          <button type="button" data-testid="in-closed-details">in closed details</button>
        </details>
        <button type="button" style={{ visibility: "hidden" }} data-testid="invisible">invisible</button>
      </Dialog>,
    );
    const first = document.querySelector<HTMLElement>('[data-testid="first"]')!;
    const summary = document.querySelector<HTMLElement>("summary")!;
    expect(active()).toBe(first);

    await act(async () => summary.focus());
    await act(async () => press("Tab"));
    expect(active()).toBe(first);

    await act(async () => press("Tab", { shiftKey: true }));
    expect(active()).toBe(summary);
  });

  test("a dialog whose only controls are hidden takes focus itself", async () => {
    await render(
      <Dialog>
        <button type="button" style={{ display: "none" }}>none</button>
        <div hidden>
          <button type="button">under hidden</button>
        </div>
      </Dialog>,
    );
    const dialog = document.querySelector<HTMLElement>('[data-testid="dialog"]')!;
    expect(active()).toBe(dialog);
  });
});

describe("useDialogFocusTrap lifecycle", () => {
  test("Escape closes only the top-most of two stacked dialogs", async () => {
    const closed: string[] = [];
    await render(
      <>
        <Dialog onClose={() => closed.push("outer")}>
          <button type="button">outer</button>
        </Dialog>
        <Dialog onClose={() => closed.push("inner")}>
          <button type="button">inner</button>
        </Dialog>
      </>,
    );
    await act(async () => press("Escape"));
    expect(closed).toEqual(["inner"]);
  });

  test("focus returns to the opener on unmount", async () => {
    const opener = document.createElement("button");
    opener.type = "button";
    document.body.appendChild(opener);
    try {
      opener.focus();
      expect(active()).toBe(opener);
      await render(
        <Dialog>
          <button type="button" data-testid="first">first</button>
        </Dialog>,
      );
      expect(active()).not.toBe(opener);

      const mounted = root!;
      root = undefined;
      await act(async () => mounted.unmount());
      expect(active()).toBe(opener);
    } finally {
      opener.remove();
    }
  });

  test("active=false suspends the trap without unmounting the dialog", async () => {
    const closed: string[] = [];
    await render(
      <Dialog active={false} onClose={() => closed.push("closed")}>
        <button type="button" data-testid="first">first</button>
      </Dialog>,
    );
    const outside = document.createElement("button");
    outside.type = "button";
    document.body.appendChild(outside);
    try {
      await act(async () => {
        outside.focus();
        outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(active()).toBe(outside);
      await act(async () => press("Escape"));
      expect(closed).toEqual([]);
    } finally {
      outside.remove();
    }
  });
});
