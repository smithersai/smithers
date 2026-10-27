import { expect, test } from "bun:test";
import { decodeFrameMessage, linksIn } from "../src/protocol";

const message = (method: string, params: unknown) => ({ jsonrpc: "2.0", method, params });

test("decodes only the documented page shortcuts", () => {
  for (const key of ["k", "K"]) {
    for (const metaKey of [false, true]) {
      for (const ctrlKey of [false, true]) {
        for (const shiftKey of [false, true]) {
          for (const altKey of [false, true]) {
            const params = { key, metaKey, ctrlKey, shiftKey, altKey };
            expect(decodeFrameMessage(message("terminal/key", params))).toEqual(
              (metaKey || ctrlKey) && !altKey ? { method: "terminal/key", key: params } : undefined,
            );
          }
        }
      }
    }
  }
  for (const key of ["", "Escape", "Enter", "j", "kk"]) {
    expect(decodeFrameMessage(message("terminal/key", {
      key, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false,
    }))).toBeUndefined();
  }
});

test("limits each terminal dimension to the unsigned 16-bit protocol range", () => {
  for (const field of ["cols", "rows"]) {
    for (const value of [0, -1, 1.5, 65536, Number.MAX_SAFE_INTEGER, 1e100, Infinity, NaN, "80", null]) {
      expect(decodeFrameMessage(message("terminal/resize", { cols: 80, rows: 24, [field]: value }))).toBeUndefined();
    }
  }
  for (const cols of [1, 80, 65535]) {
    for (const rows of [1, 24, 65535]) {
      expect(decodeFrameMessage(message("terminal/resize", { cols, rows }))).toEqual({ method: "terminal/resize", cols, rows });
    }
  }
});

test("links retain balanced URL parentheses and strip surrounding punctuation", () => {
  for (const [text, url] of [
    ["see https://en.wikipedia.org/wiki/Foo_(bar) now", "https://en.wikipedia.org/wiki/Foo_(bar)"],
    ["(https://example.com/a)", "https://example.com/a"],
    ["(https://example.com/a_(b)).", "https://example.com/a_(b)"],
    ["https://example.com/a_(b_(c))!", "https://example.com/a_(b_(c))"],
    ["https://example.com/a).", "https://example.com/a"],
  ] as const) {
    expect(linksIn(text)).toEqual([{ start: text.indexOf("https:"), url }]);
  }
});
