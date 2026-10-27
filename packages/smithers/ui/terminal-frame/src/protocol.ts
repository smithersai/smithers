/**
 * The messages between a `TerminalFrame`'s page and its frame.
 *
 * | Method | Direction | What it carries |
 * | --- | --- | --- |
 * | `terminal/initialize` | frame to page, window message | `{ nonce }`; the answer carries `{ theme, colors, readOnly }` and transfers a `MessagePort` |
 * | `terminal/output` | page to frame | `{ bytes }`: the shell's output |
 * | `terminal/options` | page to frame | `{ theme, colors, readOnly }` after any of them changes |
 * | `terminal/focus` | page to frame | `{}`: focus the terminal |
 * | `terminal/input` | frame to page | `{ data }`: what the person typed, never while read-only |
 * | `terminal/resize` | frame to page | `{ cols, rows }` after a fit that changed them |
 * | `terminal/key` | frame to page | a page shortcut (⌘K, Ctrl+K) that never reaches the shell |
 * | `terminal/link` | frame to page | `{ url }`: a web link the person clicked |
 *
 * Every message is JSON-RPC 2.0. Only `terminal/initialize` and its answer
 * travel on the window; everything after uses the port. This module is pure,
 * so the frame runtime and the page share it.
 */

/** The attribute on the frame's `<html>` that carries the nonce; `ViewCsp.nonceAttribute`. */
export const nonceAttribute = "data-smithers-nonce";

/** The id of the frame's one `terminal/initialize` request. */
export const initializeId = "smithers-terminal";

/** The longest link the page opens, in UTF-16 code units. */
export const maxUrlLength = 2048;

/** The most text one `terminal/input` may carry, in UTF-16 code units. */
export const maxInputLength = 1024 * 1024;

/** The light or dark terminal palette. */
export type TerminalFrameTheme = "light" | "dark";

/** A page shortcut the frame sent back instead of to the shell. */
export interface TerminalFrameKey {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/** A message the frame sent over its port, decoded. */
export type FrameMessage =
  | { readonly method: "terminal/input"; readonly data: string }
  | { readonly method: "terminal/resize"; readonly cols: number; readonly rows: number }
  | { readonly method: "terminal/key"; readonly key: TerminalFrameKey }
  | { readonly method: "terminal/link"; readonly url: string };

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Whether a link is an `http:` or `https:` URL no longer than {@link maxUrlLength}. */
export const isWebUrl = (url: string): boolean => {
  if (url.length > maxUrlLength || !URL.canParse(url)) return false;
  const { protocol } = new URL(url);
  return protocol === "http:" || protocol === "https:";
};

const urlPattern = /https?:\/\/[^\s"'<>`]+/g;

/** The web links in one line of terminal text, with the column each starts at. */
export const linksIn = (line: string): Array<{ readonly start: number; readonly url: string }> =>
  Array.from(line.matchAll(urlPattern), (match) => {
    let url = match[0];
    // Remove sentence punctuation and closing delimiters supplied by the surrounding text.
    // A balanced delimiter belongs to the URL (for example Wikipedia article names).
    while (/[.,;:!?)\]}]$/.test(url)) {
      const closing = url.at(-1)!;
      const opening = ({ ")": "(", "]": "[", "}": "{" } as Record<string, string>)[closing];
      if (opening !== undefined && url.split(opening).length >= url.split(closing).length) break;
      url = url.slice(0, -1);
    }
    return { start: match.index, url };
  }).filter(({ url }) => isWebUrl(url));

/** Whether a key event is one of the page's shortcuts: ⌘K or Ctrl+K, with or without Shift. */
export const isPageKey = (event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">): boolean =>
  (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k";

/** Whether a window message is this mount's `terminal/initialize`: right shape, right nonce. */
export const acceptsInitialize = (message: unknown, nonce: string): boolean =>
  isRecord(message) && message.jsonrpc === "2.0" && message.id === initializeId &&
  message.method === "terminal/initialize" && isRecord(message.params) && message.params.nonce === nonce;

/** Terminal sizes fit the unsigned 16-bit dimensions used by PTY resize protocols. */
const isDimension = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535;

const decodeKey = (params: Record<string, unknown>): TerminalFrameKey | undefined => {
  const { key, metaKey, ctrlKey, shiftKey, altKey } = params;
  if (typeof key !== "string" || key.length > 32) return undefined;
  const flags = [metaKey, ctrlKey, shiftKey, altKey];
  if (!flags.every((flag) => typeof flag === "boolean")) return undefined;
  const shortcut = { key, metaKey, ctrlKey, shiftKey, altKey } as TerminalFrameKey;
  return isPageKey(shortcut) ? shortcut : undefined;
};

/** Decodes a message from the frame's port, or `undefined` for anything this protocol does not define. */
export const decodeFrameMessage = (message: unknown): FrameMessage | undefined => {
  if (!isRecord(message) || message.jsonrpc !== "2.0" || !isRecord(message.params)) return undefined;
  const params = message.params;
  switch (message.method) {
    case "terminal/input":
      return typeof params.data === "string" && params.data.length <= maxInputLength
        ? { method: "terminal/input", data: params.data }
        : undefined;
    case "terminal/resize":
      return isDimension(params.cols) && isDimension(params.rows)
        ? { method: "terminal/resize", cols: params.cols, rows: params.rows }
        : undefined;
    case "terminal/key": {
      const key = decodeKey(params);
      return key === undefined ? undefined : { method: "terminal/key", key };
    }
    case "terminal/link":
      return typeof params.url === "string" && isWebUrl(params.url)
        ? { method: "terminal/link", url: params.url }
        : undefined;
    default:
      return undefined;
  }
};
