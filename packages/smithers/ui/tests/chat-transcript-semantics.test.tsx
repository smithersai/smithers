/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "../src/index";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("one named message log excludes timeline navigation; Escape returns to its summary", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(ChatTranscript, { rail: createElement("nav", { "aria-label": "Timeline" }, "Events") }, "A message")));
    const logs = host.querySelectorAll('[role="log"]');
    expect(logs.length).toBe(1);
    expect(logs[0]!.getAttribute("aria-label")).toBe("Messages");
    expect(logs[0]!.querySelector("nav")).toBeNull();
    const details = host.querySelector("details")!;
    details.open = true;
    await act(async () => details.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(details.open).toBe(false);
    expect(document.activeElement === details.querySelector("summary")).toBe(true);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
