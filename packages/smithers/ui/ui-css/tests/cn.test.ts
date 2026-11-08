import { describe, expect, test } from "bun:test";
import { cn, LOADING_DELAY_MS, smithersUiCss, uiCss, xtermBaseCss, SMITHERS_UI_STYLE_ATTR, REDUCED_MOTION_MEDIA_QUERY } from "../src/index.ts";

describe("framework-free root", () => {
  test("returns the assembled stylesheet and exports the independent terminal sheet", () => {
    expect(smithersUiCss()).toBe(uiCss);
    expect(xtermBaseCss).toContain(".xterm");
    expect(LOADING_DELAY_MS).toBe(300);
  });
  test("exports framework-free stylesheet metadata", () => {
    expect(SMITHERS_UI_STYLE_ATTR).toBe("data-smithers-ui");
    expect(REDUCED_MOTION_MEDIA_QUERY).toBe("(prefers-reduced-motion: reduce)");
  });
  test("composes strings, numbers, conditionals and nested arrays in order", () => {
    expect(cn("sui-button", 7, false, null, undefined, 0, "", true, 1n,
      ["active", [null, { loading: true, hidden: false }], []], { selected: 1, disabled: 0 }))
      .toBe("sui-button 7 active loading selected");
    expect(cn()).toBe("");
    expect(cn([[], false, ""])).toBe("");
  });
  test("preserves empty dictionary keys and whitespace at group boundaries", () => {
    expect(cn("a", { "": true }, ["", { "": true }], "b")).toBe("a b");
    expect(cn({ a: true, "": true, b: true }, "c")).toBe("a  b c");
    expect(cn(" ", ["a", " "])).toBe("  a  ");
  });
  test("preserves indexed array semantics, including custom iterators and accessors", () => {
    const names = ["indexed"];
    names[Symbol.iterator] = function* () { yield "iterator"; };
    expect(cn(names)).toBe("indexed");
    let reads = 0;
    const changing: string[] = [];
    Object.defineProperty(changing, 0, {
      get() { reads++; if (reads === 1) changing.push("later"); return reads === 1 ? "first" : "second"; },
    });
    expect(cn(changing)).toBe("second");
    expect(reads).toBe(2);
  });
  test("accepts a large flat class array without an argument-list limit", () => {
    const names = Array.from({ length: 200_000 }, () => "x");
    expect(cn(names)).toBe(names.join(" "));
  });
  test("preserves clsx's inherited enumerable dictionary behavior", () => {
    const values = Object.assign(Object.create({ inherited: true, absent: false }), { own: true });
    expect(cn(values)).toBe("own inherited");
  });
});
