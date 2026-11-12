/**
 * The terminal frame runtime: the only script a `TerminalFrame`'s frame runs.
 *
 * It is trusted code, written by the page and pinned by its hash in the
 * frame's CSP, with xterm.js and its fit addon bundled in. It:
 *
 * 1. asks the page to connect with `terminal/initialize`, carrying the nonce
 *    the page wrote on the frame's `<html>` element, and takes the
 *    `MessagePort` the answer transfers;
 * 2. opens xterm with the answer's colors and access, and writes each
 *    `terminal/output` it is sent;
 * 3. posts `terminal/input` for what the person types, and never while
 *    read-only: then xterm's `disableStdin` is set and nothing listens;
 * 4. posts `terminal/resize` with the first size and after each fit that
 *    changes it;
 * 5. sends ⌘K and Ctrl+K back as `terminal/key` instead of to the shell; Esc
 *    stays in the shell;
 * 6. posts `terminal/link` for a web link a person clicked, an OSC 8 link or
 *    a URL in the text, and never follows a link itself.
 *
 * It loads no clipboard (OSC 52) addon.
 */
import type { IBufferLine, IDisposable, ILink, ITheme, Terminal as XTerminal } from "@xterm/xterm";
import { initializeId, isPageKey, isRecord, isWebUrl, linksIn, nonceAttribute } from "./protocol";

/** The xterm.js modules the frame runs. */
export type TerminalFrameModules = {
  readonly Terminal: typeof import("@xterm/xterm").Terminal;
  readonly FitAddon: typeof import("@xterm/addon-fit").FitAddon;
};

/** A frame's window, with its own constructors. */
export type FrameWindow = Window & typeof globalThis;

const fontFamily = "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** Starts the runtime in a frame's window. */
export const startTerminalFrame = (frame: FrameWindow, modules: TerminalFrameModules): void => {
  const document = frame.document;
  const html = document.documentElement;
  const parent = frame.parent;
  const nonce = html.getAttribute(nonceAttribute) ?? "";
  const screen = document.createElement("div");
  screen.setAttribute("data-smithers-terminal", "");
  document.body.appendChild(screen);
  let connected = false;

  const open = (port: MessagePort, options: Record<string, unknown>) => {
    const post = (method: string, params: Record<string, unknown>) =>
      port.postMessage({ jsonrpc: "2.0", method, params });
    const follow = (event: MouseEvent, url: string) => {
      if (event.isTrusted && isWebUrl(url)) post("terminal/link", { url });
    };
    const term: XTerminal = new modules.Terminal({
      fontFamily,
      fontSize: 13,
      scrollback: 1000,
      cursorBlink: !frame.matchMedia("(prefers-reduced-motion: reduce)").matches,
      disableStdin: true,
      linkHandler: { activate: follow, allowNonHttpProtocols: false },
    });
    const fit = new modules.FitAddon();
    term.loadAddon(fit);

    let input: IDisposable | undefined;
    const apply = (next: Record<string, unknown>) => {
      if (next.theme === "light" || next.theme === "dark") html.setAttribute("data-theme", next.theme);
      if (isRecord(next.colors)) {
        const colors = next.colors as ITheme;
        term.options.theme = colors;
        document.body.style.background = colors.background ?? "";
      }
      if (typeof next.readOnly === "boolean") {
        term.options.disableStdin = next.readOnly;
        input?.dispose();
        input = next.readOnly ? undefined : term.onData((data) => post("terminal/input", { data }));
      }
    };

    term.attachCustomKeyEventHandler((event) => {
      if (!isPageKey(event)) return true;
      if (event.type === "keydown") {
        event.preventDefault();
        const { key, metaKey, ctrlKey, shiftKey, altKey } = event;
        post("terminal/key", { key, metaKey, ctrlKey, shiftKey, altKey });
      }
      return false;
    });
    term.registerLinkProvider({
      provideLinks: (y, callback) => {
        // A line longer than the terminal is wide wraps onto rows marked `isWrapped`.
        // Links are found in the whole line row `y` is part of, so a URL that wraps is
        // offered whole, from any of its rows, and never as its first row alone.
        const buffer = term.buffer.active;
        let first = y - 1;
        while (first > 0 && buffer.getLine(first)?.isWrapped) first -= 1;
        const lines: Array<IBufferLine> = [];
        for (let line = buffer.getLine(first); line !== undefined && (lines.length === 0 || line.isWrapped); line = buffer.getLine(first + lines.length)) {
          lines.push(line);
        }
        const rows = lines.map((line, index) => line.translateToString(index === lines.length - 1));
        // The cell holding the character at `offset` of the joined line.
        const cell = (offset: number) => {
          let row = 0;
          while (row < rows.length - 1 && offset >= rows[row]!.length) offset -= rows[row++]!.length;
          return { x: offset + 1, y: first + row + 1 };
        };
        const links = linksIn(rows.join("")).map(({ start, url }): ILink => ({
          range: { start: cell(start), end: cell(start + url.length - 1) },
          text: url,
          activate: follow,
        }));
        callback(links.length === 0 ? undefined : links);
      },
    });

    term.open(screen);
    apply(options);
    fit.fit();
    post("terminal/resize", { cols: term.cols, rows: term.rows });
    term.onResize(({ cols, rows }) => post("terminal/resize", { cols, rows }));
    if (typeof frame.ResizeObserver === "function") new frame.ResizeObserver(() => fit.fit()).observe(screen);

    port.onmessage = (event: MessageEvent) => {
      const message: unknown = event.data;
      if (!isRecord(message) || !isRecord(message.params)) return;
      if (message.method === "terminal/output" && message.params.bytes instanceof Uint8Array) {
        term.write(message.params.bytes);
      } else if (message.method === "terminal/options") apply(message.params);
      else if (message.method === "terminal/focus") term.focus();
    };
  };

  frame.addEventListener("message", (event: MessageEvent) => {
    if (connected || event.source !== parent) return;
    const data: unknown = event.data;
    if (!isRecord(data) || data.id !== initializeId || !isRecord(data.result) || event.ports.length !== 1) return;
    connected = true;
    open(event.ports[0]!, data.result);
  });

  parent.postMessage({ jsonrpc: "2.0", id: initializeId, method: "terminal/initialize", params: { nonce } }, "*");
};
