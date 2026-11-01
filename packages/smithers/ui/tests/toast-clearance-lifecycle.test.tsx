/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { Toast, ToastStack } from "../src";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("clearance observes mounted chrome, scroll and resize, and releases its observers and styles", async () => {
  const container = document.createElement("div");
  const header = document.createElement("header");
  document.body.append(header, container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ToastStack placement="anchored" avoid="header" />));
    expect(container.children).toHaveLength(0);
    await act(async () => root.render(<ToastStack placement="anchored" avoid="header"><Toast tone="update" /></ToastStack>));
    const stack = container.querySelector<HTMLElement>('[data-slot="toast-stack"]')!;
    expect(stack.hasAttribute("data-clearance")).toBe(true);
    expect(stack.style.getPropertyValue("--sui-toast-clearance")).toMatch(/px$/);
    expect(stack.style.getPropertyValue("--sui-toast-room")).toMatch(/px$/);
    expect(stack.style.getPropertyValue("--sui-toast-overflow")).toBe("visible");
    expect(stack.style.getPropertyValue("--sui-toast-pointer")).toBe("none");
    // Real DOM mutation delivery, including dropping an observed header.
    await act(async () => { header.remove(); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
    await act(async () => { document.body.prepend(header); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
    await act(async () => { header.className = "wrapped"; await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
    document.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    await act(async () => root.render(<ToastStack placement="anchored" avoid="header"><Toast tone="update" /><Toast tone="failed" /></ToastStack>));
    expect(container.querySelectorAll('[data-slot="toast"]')).toHaveLength(2);
    document.dispatchEvent(new Event("scroll"));
    await act(async () => root.render(<ToastStack placement="anchored"><Toast tone="update" /></ToastStack>));
    expect(stack.hasAttribute("data-clearance")).toBe(false);
    await act(async () => root.render(null));
    expect(stack.style.getPropertyValue("--sui-toast-clearance")).toBe("");
    expect(stack.style.getPropertyValue("--sui-toast-room")).toBe("");
    expect(stack.style.getPropertyValue("--sui-toast-overflow")).toBe("");
    expect(stack.style.getPropertyValue("--sui-toast-pointer")).toBe("");
    expect(container.children).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    header.remove();
    container.remove();
  }
});


test("Alt+T skips zero room and works again when the host has room", async () => {
  const container = document.createElement("div");
  const outside = document.createElement("button");
  document.body.append(outside, container);
  const root = createRoot(container);
  const render = (room: string) => root.render(<ToastStack style={{ "--sui-toast-room": room } as CSSProperties}><Toast tone="update" onHide={() => {}} /></ToastStack>);
  const focusToast = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "t", code: "KeyT", altKey: true, bubbles: true, cancelable: true }));
  try {
    await act(async () => render("0px"));
    outside.focus();
    focusToast();
    expect(document.activeElement).toBe(outside);
    await act(async () => render("100px"));
    focusToast();
    expect(document.activeElement).toBe(container.querySelector("[data-toast-focus]"));
  } finally {
    await act(async () => root.unmount());
    outside.remove();
    container.remove();
  }
});
