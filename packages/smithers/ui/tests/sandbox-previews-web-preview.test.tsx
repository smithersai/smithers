/** @jsxImportSource react */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, useState, type ReactElement } from "react";
import { createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  WebPreview,
  WebPreviewAddress,
  WebPreviewContent,
  WebPreviewToolbar,
  type WebPreviewSandboxToken,
} from "../src/sandbox/WebPreview";
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

async function typeAndEnter(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
}

describe("WebPreview", () => {
  test("renders the default composition with an address bar and locked-down iframe", async () => {
    await render(<WebPreview url="https://example.com" />);
    const frame = container!.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe("https://example.com");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(frame.getAttribute("title")).toBe("Web preview");
    expect(container!.querySelector('[data-slot="web-preview-toolbar"]')?.getAttribute("role")).toBe("toolbar");
    expect(
      container!.querySelector<HTMLInputElement>('[data-slot="web-preview-address"] input')?.getAttribute("aria-label"),
    ).toBe("Preview address");
  });

  test("no url renders an honest empty state, never a fabricated preview", async () => {
    await render(<WebPreview />);
    expect(container!.querySelector("iframe")).toBeNull();
    expect(container!.querySelector('[data-slot="web-preview-content"]')?.textContent).toContain(
      "No preview available",
    );
  });

  test("address bar commits valid http(s) URLs via onUrlChange (controlled)", async () => {
    const commits: string[] = [];
    function Harness() {
      const [url, setUrl] = useState("https://example.com");
      return (
        <WebPreview
          url={url}
          onUrlChange={(next) => {
            commits.push(next);
            setUrl(next);
          }}
        />
      );
    }
    await render(<Harness />);
    const input = container!.querySelector<HTMLInputElement>('[data-slot="web-preview-address"] input')!;
    await typeAndEnter(input, "https://other.dev/path");
    expect(commits).toEqual(["https://other.dev/path"]);
    expect(container!.querySelector("iframe")?.getAttribute("src")).toBe("https://other.dev/path");
    expect(container!.querySelector('[data-slot="web-preview-address-error"]')).toBeNull();
  });

  test("address bar rejects non-http(s) URLs inline without calling onUrlChange", async () => {
    const commits: string[] = [];
    await render(<WebPreview url="https://example.com" onUrlChange={(url) => commits.push(url)} />);
    const input = container!.querySelector<HTMLInputElement>('[data-slot="web-preview-address"] input')!;
    await typeAndEnter(input, "javascript:alert(1)");
    expect(commits).toEqual([]);
    const error = container!.querySelector('[data-slot="web-preview-address-error"]')!;
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toContain("http");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(error.id);
    expect(container!.querySelector("iframe")?.getAttribute("src")).toBe("https://example.com");
  });

  test("uncontrolled url seeds from defaultUrl and commits update the frame", async () => {
    await render(<WebPreview defaultUrl="https://a.dev" />);
    expect(container!.querySelector("iframe")?.getAttribute("src")).toBe("https://a.dev");
    const input = container!.querySelector<HTMLInputElement>('[data-slot="web-preview-address"] input')!;
    await typeAndEnter(input, "http://b.dev");
    expect(container!.querySelector("iframe")?.getAttribute("src")).toBe("http://b.dev");
  });

  test("loading shows a skeleton overlay over the frame", async () => {
    await render(<WebPreview url="https://example.com" loading />);
    expect(container!.querySelector('[data-slot="web-preview-loading"]')).not.toBeNull();
    expect(container!.querySelector('[data-slot="web-preview"]')?.getAttribute("data-loading")).toBe("true");
  });

  test("toolbar nav buttons render only when their callbacks are provided", async () => {
    await render(
      <WebPreview url="https://example.com">
        <WebPreviewToolbar onRefresh={() => {}}>
          <WebPreviewAddress />
        </WebPreviewToolbar>
        <WebPreviewContent />
      </WebPreview>,
    );
    expect(container!.querySelector('[data-slot="web-preview-back"]')).toBeNull();
    expect(container!.querySelector('[data-slot="web-preview-forward"]')).toBeNull();
    expect(container!.querySelector('[data-slot="web-preview-refresh"]')).not.toBeNull();
  });

  test("toolbar buttons fire callbacks and rove tabindex with arrow keys", async () => {
    let backs = 0;
    await render(
      <WebPreview url="https://example.com">
        <WebPreviewToolbar
          onBack={() => {
            backs += 1;
          }}
          onForward={() => {}}
        >
          <WebPreviewAddress />
        </WebPreviewToolbar>
        <WebPreviewContent />
      </WebPreview>,
    );
    const back = container!.querySelector<HTMLButtonElement>('[data-slot="web-preview-back"]')!;
    await act(async () => back.click());
    expect(backs).toBe(1);
    expect(back.tabIndex).toBe(0);
    const forward = container!.querySelector<HTMLButtonElement>('[data-slot="web-preview-forward"]')!;
    expect(forward.tabIndex).toBe(-1);

    await act(async () => {
      back.focus();
      back.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(forward);
    expect(forward.tabIndex).toBe(0);
    expect(back.tabIndex).toBe(-1);
  });

  test("address input keeps native arrow-key editing behavior in a navigable toolbar", async () => {
    await render(
      <WebPreview url="https://example.com">
        <WebPreviewToolbar onBack={() => {}} onForward={() => {}}>
          <span className="sui-webpreview-toolbar-button" contentEditable role="button" suppressContentEditableWarning>
            Editable toolbar control
          </span>
          <WebPreviewAddress />
        </WebPreviewToolbar>
        <WebPreviewContent />
      </WebPreview>,
    );
    const editable = container!.querySelector<HTMLElement>('[contenteditable="true"]')!;
    const input = container!.querySelector<HTMLInputElement>('[data-slot="web-preview-address"] input')!;

    for (const key of ["ArrowLeft", "ArrowRight"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(async () => {
        editable.focus();
        editable.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(editable);

      const inputEvent = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(async () => {
        input.focus();
        input.dispatchEvent(inputEvent);
      });
      expect(inputEvent.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(input);
    }
  });

  test("WebPreviewContent drops allow-same-origin when combined with allow-scripts and warns", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await render(
        <WebPreviewContent
          src="https://example.com"
          sandboxAllow={["allow-scripts", "allow-same-origin", "allow-forms"]}
        />,
      );
      const frame = container!.querySelector("iframe")!;
      expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("WebPreviewContent keeps allow-same-origin when scripts are not allowed", async () => {
    await render(<WebPreviewContent src="https://example.com" sandboxAllow={["allow-same-origin", "allow-forms"]} />);
    expect(container!.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-same-origin allow-forms");
  });

  test("sandbox attribute is always rendered, even with an empty token list", async () => {
    await render(<WebPreviewContent src="https://example.com" sandboxAllow={[]} />);
    expect(container!.querySelector("iframe")?.getAttribute("sandbox")).toBe("");
  });

  test("drops a mismatched-case allow-same-origin token combined with allow-scripts", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tokens = ["ALLOW-SCRIPTS", "Allow-Same-Origin"] as unknown as WebPreviewSandboxToken[];
      await render(<WebPreviewContent src="https://example.com" sandboxAllow={tokens} />);
      expect(container!.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("drops a whitespace-padded allow-same-origin token combined with allow-scripts", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tokens = [" allow-scripts ", "\tallow-same-origin\n"] as unknown as WebPreviewSandboxToken[];
      await render(<WebPreviewContent src="https://example.com" sandboxAllow={tokens} />);
      expect(container!.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("drops duplicate allow-scripts/allow-same-origin entries without duplicating the surviving token", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tokens = [
        "allow-scripts",
        "allow-scripts",
        "allow-same-origin",
        "allow-same-origin",
      ] as unknown as WebPreviewSandboxToken[];
      await render(<WebPreviewContent src="https://example.com" sandboxAllow={tokens} />);
      expect(container!.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("rejects an escaped-separator entry (tab) packed with two tokens wholesale — no salvage", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tokens = ["allow-scripts\tallow-same-origin"] as unknown as WebPreviewSandboxToken[];
      await render(<WebPreviewContent src="https://example.com" sandboxAllow={tokens} />);
      expect(container!.querySelector("iframe")?.getAttribute("sandbox")).toBe("");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("a malformed entry is never salvaged into an active iframe capability (semicolon-packed same-origin)", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tokens = ["allow-scripts", "allow-same-origin;drop-table"] as unknown as WebPreviewSandboxToken[];
      await render(<WebPreviewContent src="https://example.com" sandboxAllow={tokens} />);
      expect(container!.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("unknown tokens fail closed and are dropped with a warning", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tokens = [
        "allow-scripts",
        "allow-top-navigation-by-user-activation",
      ] as unknown as WebPreviewSandboxToken[];
      await render(<WebPreviewContent src="https://example.com" sandboxAllow={tokens} />);
      expect(container!.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("renders a plain root-relative src as a same-origin path", async () => {
    await render(<WebPreviewContent src="/dashboard" />);
    expect(container!.querySelector("iframe")?.getAttribute("src")).toBe("/dashboard");
  });

  test("refuses a single-backslash network-path src (/\\evil.com) as same-origin", async () => {
    const src = "/\\evil.com";
    expect(src).toBe("/" + String.fromCharCode(92) + "evil.com");
    await render(<WebPreviewContent src={src} />);
    expect(container!.querySelector("iframe")).toBeNull();
    expect(container!.querySelector('[data-slot="web-preview-content"]')?.textContent).toContain(
      "No preview available",
    );
  });

  test("refuses a double-backslash network-path src (/\\\\evil.com) as same-origin", async () => {
    const src = "/\\\\evil.com";
    expect(src).toBe("/" + String.fromCharCode(92) + String.fromCharCode(92) + "evil.com");
    await render(<WebPreviewContent src={src} />);
    expect(container!.querySelector("iframe")).toBeNull();
    expect(container!.querySelector('[data-slot="web-preview-content"]')?.textContent).toContain(
      "No preview available",
    );
  });

  test("refuses a protocol-relative src (//evil.com) as same-origin", async () => {
    await render(<WebPreviewContent src="//evil.com" />);
    expect(container!.querySelector("iframe")).toBeNull();
  });

  test("refuses a non-http(s) scheme passed directly as src", async () => {
    await render(<WebPreviewContent src="javascript:alert(1)" />);
    expect(container!.querySelector("iframe")).toBeNull();
  });

  test("runtime callers cannot override the hardened sandbox through spread props", async () => {
    const smuggled = {
      sandbox: "allow-scripts allow-same-origin",
    } as unknown as Record<string, string>;
    await render(<WebPreviewContent src="https://example.com" sandboxAllow={["allow-scripts"]} {...smuggled} />);
    const frame = container!.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toBe("https://example.com");
  });

  test("renders the sanitized src, not the raw caller input", async () => {
    await render(<WebPreviewContent src={"  https://example.com/path\t" as string} />);
    expect(container!.querySelector("iframe")?.getAttribute("src")).toBe("https://example.com/path");
  });

  test("roving tabindex never strands the address input or consumer children from the tab order", async () => {
    await render(
      <WebPreview url="https://example.com">
        <WebPreviewToolbar onBack={() => {}} onForward={() => {}}>
          <WebPreviewAddress />
          <button type="button" data-slot="web-preview-custom">
            Custom
          </button>
        </WebPreviewToolbar>
        <WebPreviewContent />
      </WebPreview>,
    );
    const back = container!.querySelector<HTMLButtonElement>('[data-slot="web-preview-back"]')!;
    const forward = container!.querySelector<HTMLButtonElement>('[data-slot="web-preview-forward"]')!;
    expect(back.tabIndex).toBe(0);
    expect(forward.tabIndex).toBe(-1);
    const input = container!.querySelector<HTMLInputElement>('[data-slot="web-preview-address"] input')!;
    expect(input.tabIndex).toBe(0);
    const custom = container!.querySelector<HTMLButtonElement>('[data-slot="web-preview-custom"]')!;
    expect(custom.tabIndex).toBe(0);
    await act(async () => {
      back.focus();
      back.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(forward);
    expect(input.tabIndex).toBe(0);
  });

  test("the roved tab stop survives unrelated re-renders", async () => {
    let bump!: () => void;
    function Harness() {
      const [, setN] = useState(0);
      bump = () => setN((n) => n + 1);
      return (
        <WebPreview url="https://example.com">
          <WebPreviewToolbar onBack={() => {}} onForward={() => {}}>
            <WebPreviewAddress />
          </WebPreviewToolbar>
          <WebPreviewContent />
        </WebPreview>
      );
    }
    await render(<Harness />);
    const back = container!.querySelector<HTMLButtonElement>('[data-slot="web-preview-back"]')!;
    const forward = container!.querySelector<HTMLButtonElement>('[data-slot="web-preview-forward"]')!;
    await act(async () => {
      back.focus();
      back.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    });
    expect(forward.tabIndex).toBe(0);

    // An unrelated state change re-renders the toolbar; the current item
    // must keep its stop instead of resetting to the first button.
    await act(async () => bump());
    expect(forward.tabIndex).toBe(0);
    expect(back.tabIndex).toBe(-1);
  });

  test("content region announces busy while loading so the covered frame is honest to screen readers", async () => {
    await render(<WebPreview url="https://example.com" loading />);
    const content = container!.querySelector('[data-slot="web-preview-content"]')!;
    expect(content.getAttribute("aria-busy")).toBe("true");
    expect(content.getAttribute("data-loading")).toBe("true");
  });

  test("content region is not busy once loading clears", async () => {
    await render(<WebPreview url="https://example.com" />);
    const content = container!.querySelector('[data-slot="web-preview-content"]')!;
    expect(content.getAttribute("aria-busy")).toBeNull();
    expect(content.getAttribute("data-loading")).toBe("false");
  });

  test("a controlled url change clears a stale validation error", async () => {
    let setUrl!: (url: string) => void;
    function Harness() {
      const [url, setControlledUrl] = useState("https://example.com");
      setUrl = setControlledUrl;
      return <WebPreview url={url} />;
    }
    await render(<Harness />);
    const input = container!.querySelector<HTMLInputElement>('[data-slot="web-preview-address"] input')!;
    await typeAndEnter(input, "not a url");
    expect(container!.querySelector('[data-slot="web-preview-address-error"]')).not.toBeNull();
    expect(input.getAttribute("aria-invalid")).toBe("true");

    await act(async () => setUrl("https://other.example.com"));
    expect(container!.querySelector('[data-slot="web-preview-address-error"]')).toBeNull();
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(input.value).toBe("https://other.example.com");
  });

  test("announces preview lifecycle changes through a polite live region", async () => {
    let setProps!: (next: { url: string; loading: boolean }) => void;
    function Harness() {
      const [props, setState] = useState({ url: "https://example.com", loading: false });
      setProps = setState;
      return <WebPreview url={props.url} loading={props.loading} />;
    }
    await render(<Harness />);
    const live = container!.querySelector('[data-slot="web-preview-live"]')!;
    expect(live.getAttribute("role")).toBe("status");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.className).toContain("sui-sr-only");
    expect(live.textContent).toBe("");

    await act(async () => setProps({ url: "https://example.com", loading: true }));
    expect(live.textContent).toBe("Loading preview");

    await act(async () => setProps({ url: "https://example.com", loading: false }));
    expect(live.textContent).toBe("Preview loaded");

    await act(async () => setProps({ url: "https://other.example.com", loading: false }));
    expect(live.textContent).toBe("Preview address https://other.example.com");
  });

  test("renders under the dark theme with the lane stylesheet injected", async () => {
    document.documentElement.dataset.theme = "dark";
    await render(<WebPreview url="https://example.com" />);
    expect(container!.querySelector('[data-slot="web-preview"]')).not.toBeNull();
    expect(document.querySelector(`style[${SMITHERS_UI_STYLE_ATTR}]`)?.textContent).toContain(sandboxCss.trim());
  });
});

describe("WebPreviewToolbar caller ref", () => {
  test("hands a caller ref its element and keeps roving focus", async () => {
    const ref = createRef<HTMLDivElement>();
    await render(
      <WebPreview url="https://example.com">
        <WebPreviewToolbar ref={ref} onBack={() => {}} onForward={() => {}} />
      </WebPreview>,
    );
    const toolbar = container!.querySelector<HTMLDivElement>('[data-slot="web-preview-toolbar"]')!;
    expect(ref.current).toBe(toolbar);
    const [back, forward] = [...toolbar.querySelectorAll<HTMLButtonElement>("button")];
    back!.focus();
    const right = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
    await act(async () => {
      back!.dispatchEvent(right);
    });
    expect(right.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(forward);
    expect([back!.tabIndex, forward!.tabIndex]).toEqual([-1, 0]);
    await act(async () => {
      forward!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(back);
  });
});
