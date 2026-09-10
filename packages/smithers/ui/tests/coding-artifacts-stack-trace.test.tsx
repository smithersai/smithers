/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseStackTrace, StackTrace, type StackFrameData } from "../src/artifacts/StackTrace";

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
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const current = root;
  await act(async () => current.render(element));
}

describe("parseStackTrace", () => {
  test("parses V8 frames with function names, anonymous, and eval forms", () => {
    const frames = parseStackTrace(
      [
        "Error: boom",
        "    at build (/repo/src/build.ts:12:34)",
        "    at /repo/src/index.ts:1:1",
        "    at eval (eval at <anonymous> (http://localhost/a.js:1:2), <anonymous>:3:4)",
      ].join("\n"),
    );
    expect(frames).toHaveLength(4);
    expect(frames[0]).toEqual({ raw: "Error: boom" });
    expect(frames[1]).toEqual({ functionName: "build", file: "/repo/src/build.ts", line: 12, column: 34 });
    expect(frames[2]).toEqual({ functionName: undefined, file: "/repo/src/index.ts", line: 1, column: 1 });
    expect(frames[3]!.file).toBe("<anonymous>");
    expect(frames[3]!.line).toBe(3);
    expect(frames[3]!.column).toBe(4);
  });

  test("parses JSC/Bun frames (fn@file:line:col and @file:line:col)", () => {
    const frames = parseStackTrace("run@/app/main.js:10:5\n@/app/global.js:2:7");
    expect(frames[0]).toEqual({ functionName: "run", file: "/app/main.js", line: 10, column: 5 });
    expect(frames[1]).toEqual({ functionName: undefined, file: "/app/global.js", line: 2, column: 7 });
  });

  test("keeps unmatched lines as raw frames and drops blank lines", () => {
    const frames = parseStackTrace("weird line\n\n  \nat ok (/x.js:1:1)");
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({ raw: "weird line" });
    expect(frames[1]!.file).toBe("/x.js");
  });
});

describe("StackTrace", () => {
  const frames: StackFrameData[] = [
    { functionName: "build", file: "/repo/src/build.ts", line: 12, column: 34 },
    { raw: "Error: boom" },
  ];

  test("is collapsed by default and expands via the trigger", async () => {
    await render(<StackTrace frames={frames} />);
    const trigger = container!.querySelector('[data-slot="stack-trace-trigger"]') as HTMLButtonElement;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.textContent).toContain("Stack trace");
    expect(trigger.textContent).toContain("2 frames");
    await act(async () => trigger.click());
    const content = container!.querySelector('[data-slot="stack-trace-content"]')!;
    expect(content.getAttribute("role")).toBe("region");
    expect(container!.querySelectorAll('[data-slot="stack-frame"]')).toHaveLength(2);
    expect(container!.textContent).toContain("/repo/src/build.ts:12:34");
    expect(container!.textContent).toContain("Error: boom");
  });

  test("renders raw text verbatim when no frames are given", async () => {
    await render(<StackTrace raw={"Error: x\n    at nowhere"} defaultOpen />);
    const pre = container!.querySelector(".sui-stack-raw")!;
    expect(pre.textContent).toBe("Error: x\n    at nowhere");
    expect(container!.querySelector('[data-slot="stack-frame"]')).toBeNull();
  });

  test("onFrameClick turns frames into buttons receiving the frame model", async () => {
    const clicked: StackFrameData[] = [];
    await render(<StackTrace frames={frames} defaultOpen onFrameClick={(frame) => clicked.push(frame)} />);
    const button = container!.querySelector(".sui-stack-frame-button") as HTMLButtonElement;
    await act(async () => button.click());
    expect(clicked).toEqual([frames[0]]);
  });

  test("renders under data-theme=dark", async () => {
    document.documentElement.dataset.theme = "dark";
    await render(<StackTrace frames={frames} defaultOpen />);
    expect(container!.querySelector('[data-slot="stack-trace"]')).not.toBeNull();
  });
});
