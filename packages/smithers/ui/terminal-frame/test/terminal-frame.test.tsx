/** @jsxImportSource react */
// TerminalFrame under happy-dom: real createRoot + act. happy-dom delivers no
// window message's source or ports, so the frame's side of the handshake is
// played here: a MessageEvent from the iframe's contentWindow, and a recorder
// on that window's postMessage to take the transferred port.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ViewCsp } from "@smthrs/views";
import { act, createRef, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  TerminalFrame,
  type TerminalFrameHandle,
  type TerminalFrameKey,
  type TerminalFrameProps,
  type TerminalFrameWriter,
  terminalFrameRuntime,
} from "../src/index";
import { terminalFrameCss } from "../src/frameCss";
import { themeRegistry } from "@smthrs/ui";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

// happy-dom's IntersectionObserver never reports, so each test starts without
// one and the frame mounts at once; the visibility test installs its own.
let intersectionObserver: unknown;
const navigatorRecord = globalThis.navigator as unknown as Record<string, unknown>;
const open = globalThis.open;
beforeEach(() => {
  intersectionObserver = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = intersectionObserver;
  delete navigatorRecord.userActivation;
  globalThis.open = open;
  document.documentElement.removeAttribute("data-palette");
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

interface Rendered {
  readonly inputs: Array<string>;
  readonly sizes: Array<[number, number]>;
  readonly keys: Array<TerminalFrameKey>;
  readonly writers: Array<TerminalFrameWriter>;
  readonly teardowns: Array<number>;
  readonly rerender: (props: Partial<TerminalFrameProps>) => Promise<void>;
}

async function render(props: Partial<TerminalFrameProps> = {}): Promise<Rendered> {
  const inputs: Array<string> = [];
  const sizes: Array<[number, number]> = [];
  const keys: Array<TerminalFrameKey> = [];
  const writers: Array<TerminalFrameWriter> = [];
  const teardowns: Array<number> = [];
  const element = (overrides: Partial<TerminalFrameProps>): ReactElement => (
    <TerminalFrame
      title="Ben's terminal"
      theme="light"
      stream={(write) => {
        const index = writers.push(write) - 1;
        return () => void teardowns.push(index);
      }}
      onInput={(data) => inputs.push(data)}
      onResize={(cols, rows) => sizes.push([cols, rows])}
      onKey={(key) => keys.push(key)}
      {...props}
      {...overrides}
    />
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const mounted = root;
  await act(async () => mounted.render(element({})));
  return {
    inputs,
    sizes,
    keys,
    writers,
    teardowns,
    rerender: async (overrides) => {
      await act(async () => mounted.render(element(overrides)));
    },
  };
}

const iframe = () => container!.querySelector("iframe")!;
const nonceOf = (srcdoc: string) => new RegExp(`${ViewCsp.nonceAttribute}="([^"]+)"`).exec(srcdoc)![1]!;

/** Plays the frame's `terminal/initialize` and returns the port the page transferred, with what arrives on it. */
async function handshake(options: { readonly nonce?: string; readonly source?: unknown; readonly data?: unknown } = {}) {
  const frameWindow = iframe().contentWindow!;
  const posted: Array<{ message: any; transfer: Array<MessagePort> }> = [];
  frameWindow.postMessage = ((message: unknown, _origin: string, transfer: Array<MessagePort>) =>
    posted.push({ message, transfer })) as typeof frameWindow.postMessage;
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: options.data ??
          { jsonrpc: "2.0", id: "smithers-terminal", method: "terminal/initialize", params: { nonce: options.nonce ?? nonceOf(iframe().srcdoc) } },
        source: ("source" in options ? options.source : frameWindow) as never,
      }),
    );
  });
  const port = posted[0]?.transfer[0];
  const received: Array<any> = [];
  if (port !== undefined) port.onmessage = (event) => received.push(event.data);
  return { posted, port, received };
}

const send = async (port: MessagePort, method: string, params: unknown) => {
  await act(async () => {
    port.postMessage({ jsonrpc: "2.0", method, params });
    await tick();
  });
};

const light = themeRegistry.paper.terminal.light;

describe("TerminalFrame frames the terminal", () => {
  test("in a scripts-only sandbox whose policy pins the runtime and allows no network", async () => {
    await render();
    const frame = iframe();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("title")).toBe("Ben's terminal");
    expect(frame.hasAttribute("allow")).toBe(false);
    const srcdoc = frame.srcdoc;
    expect(srcdoc).toBe(
      ViewCsp.frameDocument({ runtime: terminalFrameRuntime, nonce: nonceOf(srcdoc), theme: "light", styles: terminalFrameCss }),
    );
    expect(srcdoc).toContain(ViewCsp.hash(terminalFrameRuntime));
    expect(srcdoc).toContain("connect-src 'none'");
    expect(nonceOf(srcdoc)).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(container!.querySelector<HTMLElement>("[data-slot=terminal-frame]")!.style.background).toBe(light.background!);
  });

  test("with the runtime it is given", async () => {
    await render({ runtime: "/* runtime */" });
    expect(iframe().srcdoc).toContain("<script>/* runtime */</script>");
  });

  test("reconnects with a fresh nonce when its runtime changes and retires the old stream", async () => {
    const rendered = await render({ runtime: "/* first runtime */" });
    const firstNonce = nonceOf(iframe().srcdoc);
    const first = await handshake();
    expect(rendered.writers).toHaveLength(1);
    await rendered.rerender({ runtime: "/* second runtime */" });
    expect(iframe().srcdoc).toContain("<script>/* second runtime */</script>");
    expect(nonceOf(iframe().srcdoc)).not.toBe(firstNonce);
    expect(rendered.teardowns).toEqual([0]);
    expect((await handshake({ nonce: firstNonce })).posted).toEqual([]);
    const second = await handshake();
    expect(second.posted).toHaveLength(1);
    expect(rendered.writers).toHaveLength(2);
    await send(first.port!, "terminal/input", { data: "stale input" });
    await send(second.port!, "terminal/input", { data: "fresh input" });
    expect(rendered.inputs).toEqual(["fresh input"]);
    await act(async () => {
      rendered.writers[0]!.output("stale output");
      rendered.writers[1]!.output("fresh output");
      await tick();
    });
    expect(first.received).toEqual([]);
    expect(second.received.map((message) => new TextDecoder().decode(message.params.bytes))).toEqual(["fresh output"]);
    await rendered.rerender({ runtime: "/* second runtime */", theme: "dark" });
    expect(rendered.teardowns).toEqual([0]);
    expect(rendered.writers).toHaveLength(2);
    const mounted = root!;
    await act(async () => mounted.unmount());
    root = undefined;
    expect(rendered.teardowns).toEqual([0, 1]);
  });

  test("only while it is near the screen, with a new nonce each time it mounts", async () => {
    const observers: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
    };
    const rendered = await render();
    expect(container!.querySelector("iframe")).toBeNull();
    await act(async () => observers[0]!([{ isIntersecting: true }]));
    const first = nonceOf(iframe().srcdoc);
    const { port } = await handshake();
    expect(rendered.writers).toHaveLength(1);
    await act(async () => observers[0]!([{ isIntersecting: false }]));
    expect(container!.querySelector("iframe")).toBeNull();
    expect(rendered.teardowns).toEqual([0]);
    rendered.writers[0]!.output("after the frame went");
    await send(port!, "terminal/input", { data: "late" });
    expect(rendered.inputs).toEqual([]);
    await act(async () => observers[0]!([{ isIntersecting: true }]));
    expect(nonceOf(iframe().srcdoc)).not.toBe(first);
  });
});

describe("TerminalFrame's handshake", () => {
  test("answers its own frame's initialize with the options and a port, then streams", async () => {
    const rendered = await render({ readOnly: true, screenReaderMode: true });
    const { posted } = await handshake();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.message).toEqual({
      jsonrpc: "2.0",
      id: "smithers-terminal",
      result: { theme: "light", colors: light, readOnly: true, screenReaderMode: true },
    });
    expect(posted[0]!.transfer).toHaveLength(1);
    expect(rendered.writers).toHaveLength(1);
  });

  test("refuses another window, a wrong nonce, a malformed request, and a second initialize", async () => {
    const rendered = await render();
    expect((await handshake({ source: window })).posted).toEqual([]);
    expect((await handshake({ source: null })).posted).toEqual([]);
    const nonce = nonceOf(iframe().srcdoc);
    expect((await handshake({ data: { id: "smithers-terminal", method: "terminal/initialize", params: { nonce } } })).posted).toEqual([]);
    expect((await handshake({ data: { jsonrpc: "2.0", id: "other", method: "terminal/initialize", params: { nonce } } })).posted).toEqual([]);
    expect((await handshake({ nonce: "x".repeat(32) })).posted).toEqual([]);
    expect((await handshake({ data: { jsonrpc: "2.0", method: "terminal/initialize" } })).posted).toEqual([]);
    expect((await handshake({ data: { method: "ui/initialize", params: { nonce: nonceOf(iframe().srcdoc) } } })).posted).toEqual([]);
    expect((await handshake({ data: "terminal/initialize" })).posted).toEqual([]);
    expect(rendered.writers).toHaveLength(0);
    expect((await handshake()).posted).toHaveLength(1);
    expect((await handshake()).posted).toEqual([]);
    expect(rendered.writers).toHaveLength(1);
  });
});

describe("TerminalFrame routes the frame's messages", () => {
  test("input, size and keys to their callbacks, and nothing malformed", async () => {
    const rendered = await render();
    const { port } = await handshake();
    await send(port!, "terminal/input", { data: "ls\r" });
    await send(port!, "terminal/resize", { cols: 120, rows: 40 });
    await send(port!, "terminal/key", { key: "k", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false });
    await send(port!, "terminal/input", { data: 7 });
    await send(port!, "terminal/input", { data: "x".repeat(1024 * 1024 + 1) });
    await send(port!, "terminal/resize", { cols: 0, rows: 40 });
    await send(port!, "terminal/resize", { cols: 80, rows: 2.5 });
    await send(port!, "terminal/key", { key: "k".repeat(33), metaKey: true, ctrlKey: false, shiftKey: false, altKey: false });
    await send(port!, "terminal/key", { key: "k", metaKey: "yes", ctrlKey: false, shiftKey: false, altKey: false });
    await send(port!, "terminal/unknown", {});
    await send(port!, "terminal/input", undefined);
    await act(async () => {
      port!.postMessage({ method: "terminal/input", params: { data: "no jsonrpc" } });
      port!.postMessage(null);
      await tick();
    });
    expect(rendered.inputs).toEqual(["ls\r"]);
    expect(rendered.sizes).toEqual([[120, 40]]);
    expect(rendered.keys).toEqual([{ key: "k", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }]);
  });

  test("drops input while read-only, even if the frame sends it", async () => {
    const rendered = await render({ readOnly: true });
    const { port } = await handshake();
    await send(port!, "terminal/input", { data: "rm -rf /\r" });
    expect(rendered.inputs).toEqual([]);
    await rendered.rerender({ readOnly: false });
    await send(port!, "terminal/input", { data: "pwd\r" });
    expect(rendered.inputs).toEqual(["pwd\r"]);
  });

  test("a key without an onKey goes nowhere, and the frame keeps working", async () => {
    const rendered = await render({ onKey: undefined });
    const { port } = await handshake();
    await send(port!, "terminal/key", { key: "k", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false });
    await send(port!, "terminal/input", { data: "after" });
    expect(rendered.keys).toEqual([]);
    expect(rendered.inputs).toEqual(["after"]);
  });

  test("a clicked web link to onLink, only with the person's activation, and never another scheme", async () => {
    const links: Array<string> = [];
    await render({ onLink: (url) => links.push(url) });
    const { port } = await handshake();
    await send(port!, "terminal/link", { url: "https://example.test/one" });
    navigatorRecord.userActivation = { isActive: false };
    await send(port!, "terminal/link", { url: "https://example.test/stale" });
    navigatorRecord.userActivation = { isActive: true };
    await send(port!, "terminal/link", { url: "https://example.test/two" });
    await send(port!, "terminal/link", { url: "javascript:alert(1)" });
    await send(port!, "terminal/link", { url: "not a url" });
    await send(port!, "terminal/link", { url: `https://example.test/${"a".repeat(2048)}` });
    await send(port!, "terminal/link", { url: 7 });
    expect(links).toEqual(["https://example.test/one", "https://example.test/two"]);
  });

  test("a clicked web link opens in a new context with no opener and no referrer by default", async () => {
    const opened: Array<Array<unknown>> = [];
    globalThis.open = ((...args: Array<unknown>) => {
      opened.push(args);
      return null;
    }) as typeof globalThis.open;
    await render();
    const { port } = await handshake();
    await send(port!, "terminal/link", { url: "http://localhost:5173/" });
    expect(opened).toEqual([["http://localhost:5173/", "_blank", "noopener,noreferrer"]]);
  });
});

describe("TerminalFrame sends the frame", () => {
  test("output as transferred bytes, copying only what it cannot transfer whole", async () => {
    const rendered = await render();
    const { received } = await handshake();
    const whole = new TextEncoder().encode("hello");
    const backing = new TextEncoder().encode("..world..");
    const shared = new Uint8Array(new SharedArrayBuffer(2));
    shared.set([111, 107]);
    await act(async () => {
      rendered.writers[0]!.output(whole);
      rendered.writers[0]!.output(backing.subarray(2, 7));
      rendered.writers[0]!.output(backing.subarray(0, 2));
      rendered.writers[0]!.output(shared);
      rendered.writers[0]!.output("é");
      await tick();
    });
    const decoded = received.map((message) => [message.method, new TextDecoder().decode(message.params.bytes)]);
    expect(decoded).toEqual([
      ["terminal/output", "hello"],
      ["terminal/output", "world"],
      ["terminal/output", ".."],
      ["terminal/output", "ok"],
      ["terminal/output", "é"],
    ]);
    expect(whole.byteLength).toBe(0);
    expect(new TextDecoder().decode(backing)).toBe("..world..");
    expect(Array.from(shared)).toEqual([111, 107]);
  });

  test("new options when the theme or access changes", async () => {
    const rendered = await render();
    const { received } = await handshake();
    await rendered.rerender({ theme: "dark" });
    await rendered.rerender({ theme: "dark" });
    await rendered.rerender({ theme: "dark", readOnly: true });
    await rendered.rerender({ theme: "dark", readOnly: true, screenReaderMode: true });
    await act(async () => tick());
    expect(received).toEqual([
      { jsonrpc: "2.0", method: "terminal/options", params: { theme: "dark", colors: themeRegistry.paper.terminal.dark, readOnly: false, screenReaderMode: false } },
      { jsonrpc: "2.0", method: "terminal/options", params: { theme: "dark", colors: themeRegistry.paper.terminal.dark, readOnly: true, screenReaderMode: false } },
      { jsonrpc: "2.0", method: "terminal/options", params: { theme: "dark", colors: themeRegistry.paper.terminal.dark, readOnly: true, screenReaderMode: true } },
    ]);
  });

  test("focus through its handle, and nothing while the frame is away", async () => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
      observe() {}
      disconnect() {}
    };
    const away = createRef<TerminalFrameHandle>();
    await render({ ref: away });
    expect(container!.querySelector("iframe")).toBeNull();
    away.current!.focus();
    expect(document.activeElement).toBe(document.body);
  });

  test("focus through its handle", async () => {
    const handle = createRef<TerminalFrameHandle>();
    await render({ ref: handle });
    handle.current!.focus();
    const { received } = await handshake();
    await act(async () => {
      handle.current!.focus();
      await tick();
    });
    expect(received).toEqual([{ jsonrpc: "2.0", method: "terminal/focus", params: {} }]);
  });
});
