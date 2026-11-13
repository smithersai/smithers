/** @jsxImportSource react */
import { newNonce, themeRegistry, useNearScreen, useResolvedPalette } from "@smthrs/ui";
import { cn } from "@smthrs/ui-css";
import { ViewCsp } from "@smthrs/views";
import { type ComponentProps, type Ref, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { terminalFrameCss } from "./frameCss";
import {
  acceptsInitialize,
  decodeFrameMessage,
  initializeId,
  type TerminalFrameKey,
  type TerminalFrameTheme,
} from "./protocol";
import { terminalFrameRuntime } from "./runtime.generated";

/** Writes the shell's output into the frame. */
export type TerminalFrameWriter = {
  /**
   * Takes the bytes: a `Uint8Array` that spans its whole buffer is
   * transferred to the frame, so the caller must not use it again. A string
   * is sent as UTF-8.
   */
  readonly output: (bytes: Uint8Array | string) => void;
};

/** Called once the frame is connected, with its writer; returns the teardown. */
export type TerminalFrameStream = (write: TerminalFrameWriter) => () => void;

/** What a `ref` to a `TerminalFrame` can do. */
export type TerminalFrameHandle = {
  /** Focuses the terminal. */
  readonly focus: () => void;
};

export type TerminalFrameProps = Omit<ComponentProps<"div">, "children" | "title" | "onInput" | "onResize" | "ref"> & {
  /** The frame's accessible name. */
  title: string;
  theme: TerminalFrameTheme;
  /** Watch only: xterm's `disableStdin` is set, and no input reaches `onInput`. */
  readOnly?: boolean | undefined;
  /** Expose terminal output through xterm's accessible rows and live region. Defaults to false. */
  screenReaderMode?: boolean | undefined;
  /** Called each time the frame connects; the returned teardown runs when it goes. */
  stream: TerminalFrameStream;
  /** What the person typed, and the terminal's own replies. Never called while `readOnly`. */
  onInput: (data: string) => void;
  /** The terminal's size: first, then after each fit that changes it. */
  onResize: (cols: number, rows: number) => void;
  /** ⌘K or Ctrl+K pressed in the terminal; it never reaches the shell. */
  onKey?: ((key: TerminalFrameKey) => void) | undefined;
  /** A web link the person clicked. Defaults to opening it in a new context with no opener and no referrer. */
  onLink?: ((url: string) => void) | undefined;
  /** The frame runtime; defaults to the one this package builds. */
  runtime?: string | undefined;
  ref?: Ref<TerminalFrameHandle> | undefined;
};

const encoder = new TextEncoder();

const openLink = (url: string) => {
  globalThis.open(url, "_blank", "noopener,noreferrer");
};

/** Whether the page has a person's recent click or keypress, or `true` where the browser cannot tell. */
const activated = (): boolean => {
  const activation = (globalThis.navigator as { userActivation?: { readonly isActive: boolean } }).userActivation;
  return activation === undefined || activation.isActive;
};

/** The bytes to transfer: the array itself when it spans its buffer, else a copy that does. */
const transferable = (data: Uint8Array | string): Uint8Array<ArrayBuffer> => {
  if (typeof data === "string") return encoder.encode(data);
  const whole = data.buffer instanceof ArrayBuffer && data.byteOffset === 0 && data.byteLength === data.buffer.byteLength;
  return whole ? (data as Uint8Array<ArrayBuffer>) : data.slice();
};

/**
 * A terminal in a sandboxed frame: xterm.js runs in an opaque origin, and the
 * page holds the connection.
 *
 * The frame is `<iframe sandbox="allow-scripts" srcdoc>` whose CSP admits only
 * the frame runtime, pinned by hash, and no network. The page answers one
 * `terminal/initialize`, from this frame with this mount's nonce, and talks to
 * the frame over the port it transfers: output in, input, size, ⌘K and links
 * out. A link opens only from a person's click. The frame mounts only while it
 * is near the screen.
 */
export function TerminalFrame({
  title,
  theme,
  readOnly = false,
  screenReaderMode = false,
  stream,
  onInput,
  onResize,
  onKey,
  onLink,
  runtime = terminalFrameRuntime,
  ref,
  className,
  style,
  ...props
}: TerminalFrameProps) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const visible = useNearScreen(host);
  const frame = useRef<HTMLIFrameElement>(null);
  const colors = themeRegistry[useResolvedPalette()].terminal[theme];
  const options = useMemo(() => ({ theme, colors, readOnly, screenReaderMode }), [theme, colors, readOnly, screenReaderMode]);
  const latest = useRef({ options, stream, onInput, onResize, onKey, onLink });
  latest.current = { options, stream, onInput, onResize, onKey, onLink };
  const port = useRef<MessagePort | undefined>(undefined);

  // A fresh connection for each document, including a replacement runtime.
  const nonce = useMemo(() => (visible ? newNonce() : ""), [visible, runtime]);
  const srcDoc = useMemo(
    () =>
      visible
        ? ViewCsp.frameDocument({ runtime, nonce, theme: latest.current.options.theme, styles: terminalFrameCss })
        : undefined,
    [visible, runtime, nonce],
  );

  useEffect(() => {
    if (!visible) return;
    let teardown: (() => void) | undefined;
    const route = (raw: unknown) => {
      const message = decodeFrameMessage(raw);
      if (message === undefined) return;
      const current = latest.current;
      if (message.method === "terminal/input") {
        if (!current.options.readOnly) current.onInput(message.data);
      } else if (message.method === "terminal/resize") current.onResize(message.cols, message.rows);
      else if (message.method === "terminal/key") current.onKey?.(message.key);
      else if (activated()) (current.onLink ?? openLink)(message.url);
    };
    const onMessage = (event: MessageEvent) => {
      const source = event.source;
      if (source === null || source !== frame.current?.contentWindow || port.current !== undefined) return;
      if (!acceptsInitialize(event.data, nonce)) return;
      const channel = new MessageChannel();
      const connected = channel.port1;
      port.current = connected;
      connected.onmessage = (message) => route(message.data);
      (source as Window).postMessage({ jsonrpc: "2.0", id: initializeId, result: latest.current.options }, "*", [
        channel.port2,
      ]);
      teardown = latest.current.stream({
        output: (data) => {
          if (port.current !== connected) return;
          const bytes = transferable(data);
          connected.postMessage({ jsonrpc: "2.0", method: "terminal/output", params: { bytes } }, [bytes.buffer]);
        },
      });
    };
    globalThis.addEventListener("message", onMessage);
    return () => {
      globalThis.removeEventListener("message", onMessage);
      port.current?.close();
      port.current = undefined;
      teardown?.();
    };
  }, [visible, nonce]);

  useEffect(() => {
    port.current?.postMessage({ jsonrpc: "2.0", method: "terminal/options", params: options });
  }, [options]);

  useImperativeHandle(ref, () => ({
    focus: () => {
      frame.current?.focus();
      port.current?.postMessage({ jsonrpc: "2.0", method: "terminal/focus", params: {} });
    },
  }), []);

  return (
    <div
      ref={setHost}
      data-slot="terminal-frame"
      className={cn("sui-terminal-frame", className)}
      style={{ background: colors.background, ...style }}
      {...props}
    >
      {srcDoc === undefined ? null : (
        <iframe
          ref={frame}
          title={title}
          sandbox={ViewCsp.sandbox}
          referrerPolicy="no-referrer"
          srcDoc={srcDoc}
          style={{ display: "block", width: "100%", height: "100%", border: 0 }}
        />
      )}
    </div>
  );
}
