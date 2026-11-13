/** @jsxImportSource react */
// CopyButton under happy-dom: the host's `onCopy` decides, and the button says what happened. Snippet's copy button
// takes a name of its own (`copyLabel`).
import { afterEach, describe, expect, test } from "bun:test";
import { act, Activity, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CopyButton, Snippet } from "../src/index";
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

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const mounted = root;
  await act(async () => mounted.render(element));
}

const button = () => container!.querySelector("button")!;
const click = () => act(async () => void button().dispatchEvent(new MouseEvent("click", { bubbles: true })));
const settle = (ms = 0) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));

describe("CopyButton", () => {
  test("an earlier copied-label timer cannot unlock a pending copy", async () => {
    let calls = 0;
    let release = () => {};
    await render(<CopyButton copiedDurationMs={40} onCopy={() => {
      calls++;
      if (calls > 1) return new Promise<void>((resolve) => { release = resolve; });
    }}>Copy</CopyButton>);
    await click();
    expect(button().textContent).toBe("Copied");
    await click();
    await settle(80);
    expect(button().getAttribute("data-copying")).toBe("true");
    await click();
    expect(calls).toBe(2);
    await act(async () => release());
    expect(button().textContent).toBe("Copied");
    await settle(80);
    expect(button().textContent).toBe("Copy");
  });

  test("says Copied once the host copied, then its label again", async () => {
    let copies = 0;
    await render(
      <CopyButton onCopy={() => void copies++} copiedDurationMs={20}>
        Copy path
      </CopyButton>,
    );
    expect(button().textContent).toBe("Copy path");
    expect(button().getAttribute("data-copied")).toBe("false");
    await click();
    expect(copies).toBe(1);
    expect(button().textContent).toBe("Copied");
    expect(button().getAttribute("data-copied")).toBe("true");
    await settle(40);
    expect(button().textContent).toBe("Copy path");
  });

  test("a copy the host refused is marked failed, and a click while one is in flight copies nothing more", async () => {
    let release: (copied: boolean) => void = () => {};
    let calls = 0;
    await render(
      <CopyButton
        copiedLabel="Done"
        onCopy={() => {
          calls++;
          return new Promise<void>((resolve, reject) => (release = (copied) => (copied ? resolve() : reject(new Error("no")))));
        }}
      >
        Copy
      </CopyButton>,
    );
    await click();
    expect(button().getAttribute("data-copying")).toBe("true");
    expect(button().hasAttribute("aria-busy")).toBe(false);
    await click();
    expect(calls).toBe(1);
    await act(async () => release(false));
    await settle();
    expect(button().getAttribute("data-copy-failed")).toBe("true");
    expect(button().textContent).toBe("Copy");
    await click();
    await act(async () => release(true));
    await settle();
    expect(button().textContent).toBe("Done");
    expect(button().hasAttribute("data-copy-failed")).toBe(false);
  });

  test.each(["resolve", "reject"] as const)("a copy that %ss after unmount leaves no feedback", async (outcome) => {
    let release = () => {};
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      await render(<CopyButton onCopy={() => new Promise<void>((resolve, reject) => {
        release = outcome === "resolve" ? resolve : () => reject(new Error("copy refused"));
      })}>Copy</CopyButton>);
      await click();
      const detached = button();
      expect(detached.getAttribute("data-copying")).toBe("true");
      const pendingMarkup = detached.outerHTML;
      await act(async () => root!.unmount());
      root = undefined;
      expect(container!.childElementCount).toBe(0);
      await act(async () => release());
      await settle();
      expect(errors).toEqual([]);
      expect(container!.childElementCount).toBe(0);
      expect(detached.outerHTML).toBe(pendingMarkup);
      expect(detached.isConnected).toBe(false);
    } finally {
      console.error = originalError;
    }
  });

  test.each(["resolve", "reject"] as const)("a copy that %ss after effect cleanup preserves state when shown again", async (outcome) => {
    let release = () => {};
    const view = (mode: "visible" | "hidden") => <Activity mode={mode}>
      <CopyButton onCopy={() => new Promise<void>((resolve, reject) => {
        release = outcome === "resolve" ? resolve : () => reject(new Error("copy refused"));
      })}>Copy</CopyButton>
    </Activity>;
    await render(view("visible"));
    await click();
    expect(button().getAttribute("data-copying")).toBe("true");
    // Activity runs real effect cleanup while retaining state, making a late
    // state update observable when the same button is shown again.
    await act(async () => root!.render(view("hidden")));
    await act(async () => release());
    await act(async () => root!.render(view("visible")));
    expect(button().textContent).toBe("Copy");
    expect(button().getAttribute("data-copying")).toBe("true");
    expect(button().getAttribute("data-copied")).toBe("false");
    expect(button().hasAttribute("data-copy-failed")).toBe(false);
  });
});

describe("Snippet", () => {
  test("names its copy button with copyLabel", async () => {
    await render(<Snippet code="https://github.com/octocat/Spoon-Knife.git" copyLabel="Copy clone URL" onCopyCode={() => {}} />);
    expect(button().getAttribute("aria-label")).toBe("Copy clone URL");
  });
});
