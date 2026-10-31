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

test("the disclosure stays open while the rail stands beside the transcript, because WebKit draws nothing of a closed one", async () => {
  const wide = window.matchMedia;
  const listeners = new Set<() => void>();
  const viewport = { matches: true, addEventListener: (_: string, listener: () => void) => listeners.add(listener), removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) };
  window.matchMedia = (() => viewport) as unknown as typeof window.matchMedia;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 900 });
  try {
    await act(async () => root.render(createElement(ChatTranscript, { rail: createElement("nav", { "aria-label": "Timeline" }, "Events") })));
    const details = host.querySelector("details")!;
    expect(details.open).toBe(true);
    await act(async () => details.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(details.open).toBe(true);
    viewport.matches = false;
    for (const listener of listeners) listener();
    expect(details.open).toBe(false);
    viewport.matches = true;
    for (const listener of listeners) listener();
    expect(details.open).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.matchMedia = wide;
    if (clientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", clientWidth);
    else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  }
  expect(listeners.size).toBe(0);
});
