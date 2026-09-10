/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ApprovalCard, ApprovalNote, ApprovalResources, ApprovalRisk } from "../src/approvals/ApprovalCard";
import { SMITHERS_UI_STYLE_ATTR } from "../src/styles";
import { safeHref } from "../src/internal/safeHref";

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

function click(el: Element) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

// Drive a React-controlled textarea's onChange in happy-dom + React 19:
// focusin starts React's delegation watching, the native prototype setter
// bypasses React's value tracker, and keyup makes React re-check + fire.
function setTextareaValue(el: HTMLTextAreaElement, value: string) {
  el.dispatchEvent(new Event("focusin", { bubbles: true }));
  const nativeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el) as object, "value")?.set;
  nativeSetter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("keyup", { bubbles: true }));
}

describe("ApprovalCard", () => {
  test("renders title, summary, risk, proposed actions, and resources", async () => {
    await render(
      <ApprovalCard
        title="Delete database?"
        state="requested"
        summary="This drops the staging database."
        risk="high"
        proposedActions={["DROP DATABASE staging", "Notify #ops"]}
        resources={[
          { id: "db", label: "staging-db", kind: "postgres", href: "https://example.com/db" },
          { id: "js", label: "javascript:alert(1)", href: "javascript:alert(1)" },
        ]}
      />,
    );
    expect(container!.textContent).toContain("Delete database?");
    expect(container!.textContent).toContain("This drops the staging database.");
    expect(container!.querySelector("[data-slot='approval-risk']")!.getAttribute("data-level")).toBe("high");
    expect(container!.textContent).toContain("Risk:");
    expect(container!.querySelectorAll(".sui-approval-actions-list li")).toHaveLength(2);
    const links = container!.querySelectorAll<HTMLAnchorElement>(".sui-approval-resource a");
    expect(links).toHaveLength(1);
    expect(links[0]!.href).toContain("https://example.com/db");
  });

  test("approve and deny callbacks receive the typed note", async () => {
    const calls: Array<{ decision: string; note?: string }> = [];
    await render(
      <ApprovalCard
        title="Ship it?"
        state="requested"
        defaultNote=""
        onApprove={(note) => calls.push({ decision: "approve", note })}
        onDeny={(note) => calls.push({ decision: "deny", note })}
      />,
    );
    const textarea = container!.querySelector<HTMLTextAreaElement>(".sui-approval-note-input")!;
    await act(async () => setTextareaValue(textarea, "looks safe"));
    await act(async () => click(container!.querySelector("[data-decision='approve']")!));
    expect(calls).toEqual([{ decision: "approve", note: "looks safe" }]);
  });

  test("controlled note threads through onNoteChange", async () => {
    const notes: string[] = [];
    await render(<ApprovalCard title="t" state="requested" note="fixed" onNoteChange={(n) => notes.push(n)} />);
    const textarea = container!.querySelector<HTMLTextAreaElement>(".sui-approval-note-input")!;
    expect(textarea.value).toBe("fixed");
    await act(async () => setTextareaValue(textarea, "fixed!"));
    expect(notes).toEqual(["fixed!"]);
  });

  test("noteEditor slot replaces the default note textarea", async () => {
    await render(<ApprovalCard title="t" state="requested" noteEditor={<div>CUSTOM EDITOR</div>} />);
    expect(container!.textContent).toContain("CUSTOM EDITOR");
    expect(container!.querySelector(".sui-approval-note-input")).toBeNull();
  });

  test("actions hidden while approving; resolutions render on terminal states", async () => {
    await render(<ApprovalCard title="t" state="approving" />);
    expect(container!.querySelector("[data-slot='confirmation-actions']")).toBeNull();
    await render(<ApprovalCard title="t" state="approved" />);
    expect(container!.textContent).toContain("Approved");
  });

  test("renders under data-theme=dark", async () => {
    document.documentElement.dataset.theme = "dark";
    await render(<ApprovalCard title="t" state="requested" risk="critical" />);
    expect(container!.querySelector(".sui-approval-card")).not.toBeNull();
  });
});

describe("ApprovalRisk", () => {
  test.each(["low", "medium", "high", "critical"] as const)("renders level %s with sr text", async (level) => {
    await render(<ApprovalRisk level={level} />);
    const el = container!.querySelector("[data-slot='approval-risk']")!;
    expect(el.getAttribute("data-level")).toBe(level);
    expect(el.textContent).toContain(`Risk: ${level}`);
  });
});

describe("ApprovalResources", () => {
  test("renders kind chips and safe links only", async () => {
    await render(
      <ApprovalResources
        resources={[
          { id: "a", label: "file.ts", kind: "file" },
          { id: "b", label: "evil", href: "data:text/html;base64,x" },
        ]}
      />,
    );
    expect(container!.querySelector(".sui-approval-resource-kind")!.textContent).toBe("file");
    expect(container!.querySelectorAll("a")).toHaveLength(0);
  });

  test("control-character smuggled schemes never become links", async () => {
    await render(
      <ApprovalResources
        resources={[
          { id: "nl", label: "newline", href: "java\nscript:alert(1)" },
          { id: "tab", label: "tab", href: "java\tscript:alert(1)" },
          { id: "cr", label: "cr", href: "java\rscript:alert(1)" },
          { id: "lead", label: "leading control", href: "\x01javascript:alert(1)" },
          { id: "del", label: "del", href: "java\x7Fscript:alert(1)" },
          { id: "ok", label: "fine", href: "https://example.com/spec" },
        ]}
      />,
    );
    const links = container!.querySelectorAll<HTMLAnchorElement>(".sui-approval-resource a");
    expect(links).toHaveLength(1);
    expect(links[0]!.href).toContain("https://example.com/spec");
    expect(container!.textContent).toContain("newline");
    expect(container!.textContent).toContain("leading control");
  });
});

describe("safeHref", () => {
  test("allows http/https/mailto and scheme-less links", () => {
    expect(safeHref("https://example.com/x")).toBe("https://example.com/x");
    expect(safeHref("http://example.com")).toBe("http://example.com");
    expect(safeHref("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(safeHref("/relative/path")).toBe("/relative/path");
    expect(safeHref("#anchor")).toBe("#anchor");
  });

  test("rejects non-navigable schemes", () => {
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
    expect(safeHref("data:text/html;base64,x")).toBeUndefined();
    expect(safeHref("vbscript:x")).toBeUndefined();
    expect(safeHref("file:///etc/passwd")).toBeUndefined();
  });

  test("rejects control characters that browser URL parsing would strip", () => {
    // WHATWG URL removes \t \n \r anywhere and trims leading C0 controls, so
    // each of these would normalize onto javascript: if passed through.
    expect(safeHref("java\nscript:alert(1)")).toBeUndefined();
    expect(safeHref("java\tscript:alert(1)")).toBeUndefined();
    expect(safeHref("java\rscript:alert(1)")).toBeUndefined();
    expect(safeHref("\x01javascript:alert(1)")).toBeUndefined();
    expect(safeHref("javascrip\x7Ft:alert(1)")).toBeUndefined();
    expect(safeHref("java\x1Fscript:alert(1)")).toBeUndefined();
    expect(safeHref("https://example.com/a\x0Bb")).toBeUndefined();
  });
});

describe("ApprovalNote", () => {
  test("labels the textarea and honors readOnly", async () => {
    await render(<ApprovalNote label="Reviewer note" defaultValue="why" readOnly />);
    const label = container!.querySelector("label")!;
    const textarea = container!.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(label.textContent).toBe("Reviewer note");
    expect(label.getAttribute("for")).toBe(textarea.id);
    expect(textarea.readOnly).toBe(true);
    expect(textarea.value).toBe("why");
  });
});
