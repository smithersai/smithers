// The terminal frame runtime against a fresh happy-dom window and the real
// xterm.js. The page's side is played here: an answer to `terminal/initialize`
// that transfers a port, and messages on that port. A subclass of xterm's
// Terminal only records what the runtime handed it (its options and link
// providers); everything else is xterm's own behaviour.
import { describe, expect, test } from "bun:test";
import { FitAddon } from "@xterm/addon-fit";
import { type ILink, type ILinkProvider, type ITerminalOptions, Terminal } from "@xterm/xterm";
import { Window } from "happy-dom";
import { ViewCsp } from "@smthrs/views";
import { type FrameWindow, startTerminalFrame } from "../src/frame";
import { initializeId, nonceAttribute } from "../src/protocol";

const nonce = "n".repeat(32);
const encoder = new TextEncoder();

/** The real xterm Terminal, recording the options and link providers the runtime gives it. */
class Recorded extends Terminal {
  static last: Recorded | undefined;
  readonly given: ITerminalOptions;
  readonly providers: Array<ILinkProvider> = [];
  constructor(options: ITerminalOptions) {
    super(options);
    this.given = options;
    Recorded.last = this;
  }
  override registerLinkProvider(provider: ILinkProvider) {
    this.providers.push(provider);
    return super.registerLinkProvider(provider);
  }
}

type ResizeCallback = () => void;

/** A frame of its own: a fresh window whose parent is itself, as happy-dom makes one. */
const frame = (options: { readonly resize?: "none" | Array<ResizeCallback> } = {}) => {
  const window = new Window();
  const asked: Array<unknown> = [];
  window.document.documentElement.setAttribute(nonceAttribute, nonce);
  window.postMessage = ((message: unknown) => asked.push(message)) as typeof window.postMessage;
  const observers = options.resize;
  if (observers === "none") (window as unknown as { ResizeObserver: unknown }).ResizeObserver = undefined;
  else if (observers !== undefined) {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      constructor(callback: ResizeCallback) {
        observers.push(callback);
      }
      observe() {}
    };
  }
  startTerminalFrame(window as unknown as FrameWindow, { Terminal: Recorded, FitAddon });
  return { window, document: window.document, asked };
};

type Opened = ReturnType<typeof frame>;

const waitFor = async <T>(get: () => T | undefined | false, timeoutMs = 4000): Promise<T> => {
  const start = Date.now();
  for (;;) {
    const value = get();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const result = { theme: "dark", colors: { background: "#101010", foreground: "#eeeeee" }, readOnly: false };

/** Answers the frame's `terminal/initialize` with a port, and collects what the frame posts on it. */
const connect = async (opened: Opened, answer: Record<string, unknown> = result) => {
  Recorded.last = undefined;
  const channel = new MessageChannel();
  const received: Array<any> = [];
  channel.port2.onmessage = (event) => received.push(event.data);
  opened.window.dispatchEvent(
    new opened.window.MessageEvent("message", {
      data: { jsonrpc: "2.0", id: initializeId, result: answer },
      source: opened.window as never,
      ports: [channel.port1 as never],
    }),
  );
  const term = await waitFor(() => Recorded.last);
  await waitFor(() => received.length > 0);
  return { port: channel.port2, received, term };
};

const of = (received: Array<any>, method: string) =>
  received.filter((message) => message.method === method).map((message) => message.params);

const line = (term: Terminal, row: number) => term.buffer.active.getLine(row)?.translateToString(true) ?? "";

const write = (term: Terminal, text: string) => new Promise<void>((resolve) => term.write(text, resolve));

/** A key a person presses in the terminal. */
const press = (opened: Opened, init: KeyboardEventInit) => {
  const event = new opened.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  opened.document.querySelector("textarea")!.dispatchEvent(event as never);
  return event;
};

/** A click as a person makes one: trusted, unless said otherwise. */
const click = (opened: Opened, trusted = true) => {
  const event = new opened.window.MouseEvent("mouseup");
  Object.defineProperty(event, "isTrusted", { value: trusted });
  return event as unknown as MouseEvent;
};

const linksAt = (term: Recorded, y: number, provider = 0) =>
  new Promise<Array<ILink> | undefined>((resolve) => term.providers[provider]!.provideLinks(y, resolve));

describe("the terminal frame runtime", () => {
  test("asks its parent once, with the nonce it was written with, and the page's nonce attribute", () => {
    const opened = frame();
    expect(nonceAttribute).toBe(ViewCsp.nonceAttribute);
    expect(opened.asked).toEqual([{ jsonrpc: "2.0", id: initializeId, method: "terminal/initialize", params: { nonce } }]);
    expect(opened.document.querySelectorAll("[data-smithers-terminal]")).toHaveLength(1);
  });

  test("asks with an empty nonce when the document carries none", () => {
    const window = new Window();
    const asked: Array<any> = [];
    window.postMessage = ((message: unknown) => asked.push(message)) as typeof window.postMessage;
    startTerminalFrame(window as unknown as FrameWindow, { Terminal: Recorded, FitAddon });
    expect(asked[0].params).toEqual({ nonce: "" });
  });

  test("takes only the parent's answer to its request, carrying one port, once", async () => {
    const opened = frame();
    const send = (data: unknown, options: { readonly source?: unknown; readonly ports?: number } = {}) =>
      opened.window.dispatchEvent(
        new opened.window.MessageEvent("message", {
          data,
          source: (options.source ?? opened.window) as never,
          ports: Array.from({ length: options.ports ?? 1 }, () => new MessageChannel().port1) as never,
        }),
      );
    Recorded.last = undefined;
    const answer = { jsonrpc: "2.0", id: initializeId, result };
    send(answer, { source: new Window() });
    send({ ...answer, id: 7 });
    send({ jsonrpc: "2.0", id: initializeId });
    send("text");
    send(answer, { ports: 0 });
    send(answer, { ports: 2 });
    expect(Recorded.last).toBeUndefined();
    const { term } = await connect(opened);
    send(answer);
    expect(Recorded.last).toBe(term);
    expect(opened.document.querySelectorAll(".xterm")).toHaveLength(1);
  });

  test("opens xterm with the answer's colors and theme, and no stdin or link-following of its own", async () => {
    const opened = frame();
    const { term } = await connect(opened);
    expect(term.options.theme).toEqual(result.colors);
    expect(term.options.disableStdin).toBe(false);
    expect(opened.document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(opened.document.body.style.background).toBe("#101010");
    expect(term.given.linkHandler?.allowNonHttpProtocols).toBe(false);
    expect(term.given.fontSize).toBe(13);
  });

  test("starts read-only when the answer does not say", async () => {
    const opened = frame();
    const { term, received } = await connect(opened, { theme: "light", colors: {} });
    expect(term.options.disableStdin).toBe(true);
    expect(opened.document.body.style.background).toBe("");
    term.input("ls\r");
    // Messages on a port arrive in order: an input posted before this resize would be here by now.
    term.resize(90, 20);
    await waitFor(() => of(received, "terminal/resize").length >= 2);
    expect(of(received, "terminal/input")).toEqual([]);
  });

  test("writes the bytes it is sent, and ignores what is not output", async () => {
    const opened = frame();
    const { port, term } = await connect(opened);
    port.postMessage({ jsonrpc: "2.0", method: "terminal/output", params: { bytes: encoder.encode("hello\r\nworld") } });
    await waitFor(() => line(term, 1) === "world");
    port.postMessage({ jsonrpc: "2.0", method: "terminal/output", params: { bytes: "a string is not output" } });
    port.postMessage({ jsonrpc: "2.0", method: "terminal/output" });
    port.postMessage("text");
    port.postMessage({ jsonrpc: "2.0", method: "something/else", params: {} });
    port.postMessage({ jsonrpc: "2.0", method: "terminal/output", params: { bytes: encoder.encode("!") } });
    await waitFor(() => line(term, 1) === "world!");
    expect([line(term, 0), line(term, 1)]).toEqual(["hello", "world!"]);
  });

  test("posts what the person types while writable, and nothing while read-only", async () => {
    const opened = frame();
    const { port, received, term } = await connect(opened);
    term.input("ls\r");
    port.postMessage({ jsonrpc: "2.0", method: "terminal/options", params: { readOnly: true } });
    await waitFor(() => term.options.disableStdin);
    term.input("rm -rf /\r");
    port.postMessage({ jsonrpc: "2.0", method: "terminal/options", params: { readOnly: false } });
    await waitFor(() => !term.options.disableStdin);
    term.input("pwd\r");
    await waitFor(() => of(received, "terminal/input").length >= 2);
    expect(of(received, "terminal/input")).toEqual([{ data: "ls\r" }, { data: "pwd\r" }]);
  });

  test("applies new colors and a new theme, and leaves what a change omits", async () => {
    const opened = frame();
    const { port, term } = await connect(opened);
    port.postMessage({ jsonrpc: "2.0", method: "terminal/options", params: { theme: "light", colors: { background: "#fafafa" } } });
    await waitFor(() => opened.document.documentElement.getAttribute("data-theme") === "light");
    expect(term.options.theme).toEqual({ background: "#fafafa" });
    expect(opened.document.body.style.background).toBe("#fafafa");
    port.postMessage({ jsonrpc: "2.0", method: "terminal/options", params: { theme: "neon", colors: "red", readOnly: "yes" } });
    port.postMessage({ jsonrpc: "2.0", method: "terminal/focus", params: {} });
    await waitFor(() => opened.document.activeElement?.localName === "textarea");
    expect(opened.document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(term.options.theme).toEqual({ background: "#fafafa" });
    expect(term.options.disableStdin).toBe(false);
  });

  test("sends ⌘K and Ctrl+K to the page instead of the shell, and keeps Esc in the shell", async () => {
    const opened = frame();
    const { received } = await connect(opened);
    const meta = press(opened, { key: "k", code: "KeyK", keyCode: 75, metaKey: true });
    const ctrl = press(opened, { key: "K", code: "KeyK", keyCode: 75, ctrlKey: true, shiftKey: true });
    opened.document.querySelector("textarea")!.dispatchEvent(
      new opened.window.KeyboardEvent("keyup", { key: "k", keyCode: 75, ctrlKey: true, bubbles: true }) as never,
    );
    press(opened, { key: "k", code: "KeyK", keyCode: 75, ctrlKey: true, altKey: true });
    press(opened, { key: "Escape", code: "Escape", keyCode: 27 });
    await waitFor(() => of(received, "terminal/input").length >= 2);
    expect([meta.defaultPrevented, ctrl.defaultPrevented]).toEqual([true, true]);
    expect(of(received, "terminal/key")).toEqual([
      { key: "k", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false },
      { key: "K", metaKey: false, ctrlKey: true, shiftKey: true, altKey: false },
    ]);
    // Ctrl+Alt+K is the shell's (ESC then Ctrl+K), as is Esc; neither ⌘K nor Ctrl+K reached it.
    expect(of(received, "terminal/input")).toEqual([{ data: "\x1b\x0b" }, { data: "\x1b" }]);
  });

  test("reports its size first, after each fit that changes it, and fits when its screen resizes", async () => {
    const callbacks: Array<ResizeCallback> = [];
    const opened = frame({ resize: callbacks });
    const { received, term } = await connect(opened);
    expect(of(received, "terminal/resize")).toEqual([{ cols: term.cols, rows: term.rows }]);
    term.resize(100, 30);
    expect(callbacks).toHaveLength(1);
    callbacks[0]!();
    term.resize(100, 30);
    await waitFor(() => of(received, "terminal/resize").length >= 2);
    expect(of(received, "terminal/resize")).toEqual([{ cols: 80, rows: 24 }, { cols: 100, rows: 30 }]);
  });

  test("runs without a ResizeObserver", async () => {
    const opened = frame({ resize: "none" });
    const { received } = await connect(opened);
    expect(of(received, "terminal/resize")).toEqual([{ cols: 80, rows: 24 }]);
  });

  test("posts a web link a person clicked, and never one a script clicked or one that is not http(s)", async () => {
    const opened = frame();
    const { received, term } = await connect(opened);
    const activate = term.given.linkHandler!.activate;
    activate(click(opened), "https://example.test/osc8", { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } });
    activate(click(opened, false), "https://example.test/scripted", { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } });
    activate(click(opened), "javascript:alert(1)", { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } });
    activate(click(opened), "file:///etc/passwd", { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } });
    await waitFor(() => received.some((message) => message.method === "terminal/link"));
    expect(of(received, "terminal/link")).toEqual([{ url: "https://example.test/osc8" }]);
  });

  test("finds the web links in a line of output, and offers each to be clicked", async () => {
    const opened = frame();
    const { received, term } = await connect(opened);
    await write(term, "see https://example.test/a?b=1. and (http://x.test/p) or\r\nftp://no.test http://[::bad\r\nplain text");
    expect(term.buffer.active.getLine(1)!.isWrapped).toBe(false);
    const links = (await linksAt(term, 1))!;
    expect(links.map((link) => [link.text, link.range.start.x, link.range.end.x])).toEqual([
      ["https://example.test/a?b=1", 5, 30],
      ["http://x.test/p", 38, 52],
    ]);
    expect(await linksAt(term, 2)).toBeUndefined();
    expect(await linksAt(term, 5000)).toBeUndefined();
    links[1]!.activate(click(opened), links[1]!.text);
    await waitFor(() => received.some((message) => message.method === "terminal/link"));
    expect(of(received, "terminal/link")).toEqual([{ url: "http://x.test/p" }]);
  });

  test("finds a web link that wraps onto a second row whole, from either row, and offers it with its full range", async () => {
    const opened = frame();
    const { received, term } = await connect(opened);
    const url = "https://example.test/login/oauth/authorize?client_id=Iv1.b507a08c87ecfe98&redirect_uri=http%3A%2F%2F127.0.0.1%3A53682%2Fcallback&state=xyz";
    expect(url.length).toBeGreaterThan(term.cols);
    await write(term, `Open ${url} now\r\n${"-".repeat(term.cols)}see http://x.test/second\r\nplain text`);
    // The line wrapped: row 2 continues row 1, and row 4 continues row 3.
    expect([1, 2, 3, 4].map((row) => term.buffer.active.getLine(row - 1)!.isWrapped)).toEqual([false, true, false, true]);
    const wrapped = { text: url, start: { x: 6, y: 1 }, end: { x: 5 + url.length - term.cols, y: 2 } };
    const at = (y: number) => linksAt(term, y).then((links) => links?.map((link) => ({ text: link.text, ...link.range })));
    expect(await at(1)).toEqual([wrapped]);
    expect(await at(2)).toEqual([wrapped]);
    expect(await at(3)).toEqual([{ text: "http://x.test/second", start: { x: 5, y: 4 }, end: { x: 24, y: 4 } }]);
    expect(await at(4)).toEqual([{ text: "http://x.test/second", start: { x: 5, y: 4 }, end: { x: 24, y: 4 } }]);
    expect(await at(5)).toBeUndefined();
    const [link] = (await linksAt(term, 2))!;
    link!.activate(click(opened), link!.text);
    await waitFor(() => received.some((message) => message.method === "terminal/link"));
    expect(of(received, "terminal/link")).toEqual([{ url }]);
  });
});

describe("terminal access and link destinations", () => {
  test("read-only Tab and Shift+Tab keep browser focus navigation, including after access changes", async () => {
    const opened = frame();
    const { port, term, received } = await connect(opened, { ...result, readOnly: true });
    for (const shiftKey of [false, true]) {
      expect(press(opened, { key: "Tab", keyCode: 9, shiftKey }).defaultPrevented).toBe(false);
    }
    port.postMessage({ method: "terminal/options", params: { readOnly: false } });
    await waitFor(() => !term.options.disableStdin);
    expect(press(opened, { key: "Tab", keyCode: 9 }).defaultPrevented).toBe(true);
    await waitFor(() => of(received, "terminal/input").length === 1);
    expect(of(received, "terminal/input")).toEqual([{ data: "\t" }]);
  });

  test("Ctrl+Shift+M toggles Tab focus navigation without reaching the shell", async () => {
    const opened = frame();
    const { received } = await connect(opened);
    for (const type of ["keydown", "keyup"]) {
      opened.document.querySelector("textarea")!.dispatchEvent(new opened.window.KeyboardEvent(type, {
        key: "M", keyCode: 77, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
      }) as never);
    }
    for (const shiftKey of [false, true]) {
      expect(press(opened, { key: "Tab", keyCode: 9, shiftKey }).defaultPrevented).toBe(false);
    }
    // Holding the toggle cannot toggle back on repeated keydown.
    press(opened, { key: "M", keyCode: 77, ctrlKey: true, shiftKey: true, repeat: true });
    expect(press(opened, { key: "Tab", keyCode: 9 }).defaultPrevented).toBe(false);
    press(opened, { key: "m", keyCode: 77, ctrlKey: true, shiftKey: true });
    expect(press(opened, { key: "Tab", keyCode: 9 }).defaultPrevented).toBe(true);
    await waitFor(() => of(received, "terminal/input").length > 0);
    expect(of(received, "terminal/input")).toEqual([{ data: "\t" }]);
  });

  test("screen-reader output follows the initial option and later changes, ignoring invalid values", async () => {
    const opened = frame();
    const { term, port } = await connect(opened, { ...result, screenReaderMode: true });
    expect(term.options.screenReaderMode).toBe(true);
    expect(opened.document.querySelector(".xterm-accessibility")).not.toBeNull();
    port.postMessage({ method: "terminal/options", params: { screenReaderMode: false } });
    await waitFor(() => !term.options.screenReaderMode);
    expect(opened.document.querySelector(".xterm-accessibility")).toBeNull();
    port.postMessage({ method: "terminal/options", params: { screenReaderMode: "yes" } });
    port.postMessage({ method: "terminal/focus", params: {} });
    await waitFor(() => opened.document.activeElement?.localName === "textarea");
    expect(term.options.screenReaderMode).toBe(false);
  });

  test("OSC 8 hover shows the full destination as text and leave hides it", async () => {
    const opened = frame();
    const { term } = await connect(opened);
    const handler = term.given.linkHandler!;
    const range = { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } };
    const target = "https://example.test/<img>?q=hello";
    handler.hover!(click(opened), target, range);
    const strip = opened.document.querySelector<HTMLButtonElement>("[data-smithers-terminal-link]")!;
    expect(strip.hidden).toBe(false);
    expect(strip.textContent).toBe(target);
    expect(strip.querySelector("img")).toBeNull();
    expect(strip.disabled).toBe(true);
    handler.leave!(click(opened), target, range);
    expect(strip.hidden).toBe(true);
    handler.hover!(click(opened), "javascript:alert(1)", range);
    expect(strip.hidden).toBe(true);
  });

  test("a misleading OSC 8 URL needs a trusted second click on its actual destination", async () => {
    const opened = frame();
    const { term, received } = await connect(opened);
    const visible = "https://github.com/login/device";
    const target = "https://attacker.test/device";
    await write(term, visible);
    const range = { start: { x: 1, y: 1 }, end: { x: visible.length, y: 1 } };
    const handler = term.given.linkHandler!;
    handler.activate(click(opened), target, range);
    term.resize(90, 25);
    await waitFor(() => of(received, "terminal/resize").length === 2);
    expect(of(received, "terminal/link")).toEqual([]);
    const strip = opened.document.querySelector<HTMLButtonElement>("[data-smithers-terminal-link]")!;
    expect(strip.hidden).toBe(false);
    expect(strip.textContent).toBe(target);
    expect(strip.disabled).toBe(false);
    handler.leave!(click(opened), target, range);
    expect(strip.hidden).toBe(false);
    // xterm hovers the link under a resting pointer again after a render.
    handler.hover!(click(opened), target, range);
    expect(strip.disabled).toBe(false);
    strip.click();
    term.resize(91, 25);
    await waitFor(() => of(received, "terminal/resize").length === 3);
    expect(of(received, "terminal/link")).toEqual([]);
    // The second click of a double-click is trusted, and still confirms nothing.
    const second = new opened.window.MouseEvent("click", { detail: 2 });
    Object.defineProperty(second, "isTrusted", { value: true });
    strip.dispatchEvent(second);
    term.resize(92, 25);
    await waitFor(() => of(received, "terminal/resize").length === 4);
    expect(of(received, "terminal/link")).toEqual([]);
    const confirm = new opened.window.MouseEvent("click");
    Object.defineProperty(confirm, "isTrusted", { value: true });
    strip.dispatchEvent(confirm);
    await waitFor(() => of(received, "terminal/link").length === 1);
    expect(of(received, "terminal/link")).toEqual([{ url: target }]);
    expect(strip.hidden).toBe(true);
  });

  test("hovering another link withdraws a pending confirmation", async () => {
    const opened = frame();
    const { term, received } = await connect(opened);
    const visible = "https://github.com/login/device";
    await write(term, visible);
    const range = { start: { x: 1, y: 1 }, end: { x: visible.length, y: 1 } };
    const handler = term.given.linkHandler!;
    handler.activate(click(opened), "https://attacker.test/device", range);
    const strip = opened.document.querySelector<HTMLButtonElement>("[data-smithers-terminal-link]")!;
    expect(strip.disabled).toBe(false);
    handler.hover!(click(opened), "https://example.test/other", range);
    expect(strip.textContent).toBe("https://example.test/other");
    expect(strip.disabled).toBe(true);
    const confirm = new opened.window.MouseEvent("click");
    Object.defineProperty(confirm, "isTrusted", { value: true });
    strip.dispatchEvent(confirm);
    term.resize(90, 25);
    await waitFor(() => of(received, "terminal/resize").length === 2);
    expect(of(received, "terminal/link")).toEqual([]);
  });

  test("same-host URL labels open normally and plain URL previews show and clear", async () => {
    const opened = frame();
    const { term, received } = await connect(opened);
    const visible = "https://example.test/label";
    const target = "https://example.test/target";
    await write(term, visible);
    const range = { start: { x: 1, y: 1 }, end: { x: visible.length, y: 1 } };
    term.given.linkHandler!.activate(click(opened), target, range);
    await waitFor(() => of(received, "terminal/link").length === 1);
    expect(of(received, "terminal/link")).toEqual([{ url: target }]);
    const link = (await linksAt(term, 1))![0]!;
    link.hover!(click(opened), link.text);
    const strip = opened.document.querySelector<HTMLButtonElement>("[data-smithers-terminal-link]")!;
    expect(strip.textContent).toBe(visible);
    expect(strip.hidden).toBe(false);
    link.leave!(click(opened), link.text);
    expect(strip.hidden).toBe(true);
  });

  test.each(["https", "HTTPS", "hTtPs"])("a wrapped OSC 8 %s label is checked from its continuation row", async (scheme) => {
    const opened = frame();
    const { term, received } = await connect(opened);
    term.resize(20, 24);
    const visible = `${scheme}://trusted.test/a-long-path`;
    await write(term, visible);
    // xterm supplies only the clicked physical row, even when an OSC 8 label wraps.
    const range = { start: { x: 1, y: 2 }, end: { x: visible.length - 20, y: 2 } };
    term.given.linkHandler!.activate(click(opened), "https://other.test/path", range);
    term.resize(21, 24);
    await waitFor(() => of(received, "terminal/resize").length >= 3);
    expect(of(received, "terminal/link")).toEqual([]);
    expect(opened.document.querySelector("[data-smithers-terminal-link]")!.textContent).toBe("https://other.test/path");
  });
});

test.each(["", "界 ", "prefix "])("long wrapped URL labels after %s still require confirmation", async (prefix) => {
  const opened = frame();
  const { term, received } = await connect(opened);
  term.resize(40, 24);
  await write(term, prefix + "HTTPS://trusted.test/" + "a".repeat(2100));
  const range = { start: { x: 1, y: 2 }, end: { x: 40, y: 2 } };
  term.given.linkHandler!.activate(click(opened), "https://other.test/path", range);
  term.resize(41, 24);
  await waitFor(() => of(received, "terminal/resize").length >= 3);
  expect(of(received, "terminal/link")).toEqual([]);
  expect(opened.document.querySelector("[data-smithers-terminal-link]")!.textContent).toBe("https://other.test/path");
});

test("a URL beside an ordinary OSC 8 label does not require confirmation", async () => {
  const opened = frame();
  const { term, received } = await connect(opened);
  const prefix = "https://trusted.test/ ";
  await write(term, prefix + "open");
  const range = { start: { x: prefix.length + 1, y: 1 }, end: { x: prefix.length + 4, y: 1 } };
  term.given.linkHandler!.activate(click(opened), "https://other.test/path", range);
  await waitFor(() => of(received, "terminal/link").length === 1);
  expect(of(received, "terminal/link")).toEqual([{ url: "https://other.test/path" }]);
});
