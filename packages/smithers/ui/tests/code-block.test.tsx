import { afterEach, describe, expect, jest, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeBlock, SMITHERS_UI_STYLE_ATTR } from "../src/index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const mountedRoot = root;
    await act(async () => mountedRoot.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  delete document.documentElement.dataset.theme;
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((el) => el.remove());
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const mountedRoot = root;
  await act(async () => mountedRoot.render(element));
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function advanceTimersByTime(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

describe("CodeBlock", () => {
  test("renders the frozen anatomy, language, and optional line numbers", () => {
    const html = renderToStaticMarkup(
      <CodeBlock code={"const x = 1;\nreturn x;"} language="typescript" showLineNumbers onCopyCode={() => {}} />,
    );
    expect(html).toContain('data-slot="code-block"');
    expect(html).toContain('data-wrap="false"');
    expect(html).toContain('data-copied="false"');
    expect(html).toContain("sui-codeblock-lang");
    expect(html).toContain("typescript");
    expect(html).toContain("sui-codeblock-lineno");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('aria-label="Copy code"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="typescript code"');
  });

  test("copy calls the seam and repeated clicks restart the copied timer", async () => {
    jest.useFakeTimers();
    try {
      const copied: string[] = [];
      await render(<CodeBlock code="copy me" copiedDurationMs={1_000} onCopyCode={(code) => void copied.push(code)} />);
      const block = container!.querySelector('[data-slot="code-block"]')!;
      const button = container!.querySelector('[data-slot="code-block-copy"]')!;

      await click(button);
      expect(copied).toEqual(["copy me"]);
      expect(block.getAttribute("data-copied")).toBe("true");
      expect(button.textContent).toBe("Copied");

      await advanceTimersByTime(400);
      await click(button);
      await advanceTimersByTime(601);
      expect(copied).toEqual(["copy me", "copy me"]);
      expect(block.getAttribute("data-copied")).toBe("true");

      await advanceTimersByTime(399);
      expect(block.getAttribute("data-copied")).toBe("false");
      expect(button.textContent).toBe("Copy");
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test("wrap toggle updates aria-pressed, data-wrap, and the change seam", async () => {
    const changes: boolean[] = [];
    await render(<CodeBlock code="a long line" onWrapChange={(next) => changes.push(next)} />);
    const block = container!.querySelector('[data-slot="code-block"]')!;
    const button = container!.querySelector('[data-slot="code-block-wrap"]')!;
    expect(button.getAttribute("aria-pressed")).toBe("false");

    await click(button);
    expect(changes).toEqual([true]);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(block.getAttribute("data-wrap")).toBe("true");
  });

  test("controlled wrap requests a change without self-managing", async () => {
    const changes: boolean[] = [];
    await render(<CodeBlock code="controlled" wrap={false} onWrapChange={(next) => changes.push(next)} />);
    const button = container!.querySelector('[data-slot="code-block-wrap"]')!;
    await click(button);
    expect(changes).toEqual([true]);
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  test("defaultWrap seeds uncontrolled wrapping", () => {
    const html = renderToStaticMarkup(<CodeBlock code="wrapped" defaultWrap />);
    expect(html).toContain('data-wrap="true"');
    expect(html).toContain('aria-pressed="true"');
  });

  test("renders highlighter token colors and passes language to the seam", () => {
    const calls: Array<[string, string | undefined]> = [];
    const html = renderToStaticMarkup(
      <CodeBlock
        code="const value"
        language="ts"
        highlight={(code, language) => {
          calls.push([code, language]);
          return [[{ text: "const", color: "var(--syntax-keyword)" }, { text: " value" }]];
        }}
      />,
    );
    expect(calls).toEqual([["const value", "ts"]]);
    expect(html).toContain("color:var(--syntax-keyword)");
    expect(html).toContain("const");
    expect(html).toContain(" value");
  });

  test("falls back to plain text when the highlighter throws", () => {
    const html = renderToStaticMarkup(
      <CodeBlock
        code={'plain <text> & "safe"'}
        highlight={() => {
          throw new Error("adapter unavailable");
        }}
      />,
    );
    expect(html).toContain("plain &lt;text&gt; &amp; &quot;safe&quot;");
  });

  test("falls back to plain text when the highlighter returns null", () => {
    const html = renderToStaticMarkup(<CodeBlock code="plain fallback" highlight={() => null} />);
    expect(html).toContain("plain fallback");
  });

  test("uses navigator.clipboard when no copy seam is provided", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (code: string) => {
          copied.push(code);
        },
      },
    });
    try {
      await render(<CodeBlock code="clipboard fallback" />);
      await click(container!.querySelector('[data-slot="code-block-copy"]')!);
      expect(copied).toEqual(["clipboard fallback"]);
    } finally {
      if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  test("showCopy false hides both copy paths", () => {
    const html = renderToStaticMarkup(<CodeBlock code="hidden copy" showCopy={false} onCopyCode={() => {}} />);
    expect(html).not.toContain('data-slot="code-block-copy"');
  });

  test("hides copy when neither a seam nor clipboard is available", () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    try {
      const html = renderToStaticMarkup(<CodeBlock code="no copy" />);
      expect(html).not.toContain('data-slot="code-block-copy"');
    } finally {
      if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });
});
