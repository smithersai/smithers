import { describe, expect, test } from "bun:test";
import { parseBool, parseNum } from "../src/utils/parse";

describe("utils: parse", () => {
  test("parseBool cases", () => {
    expect(parseBool("true")).toBe(true);
    expect(parseBool("1")).toBe(true);
    expect(parseBool("0")).toBe(false);
    expect(parseBool("false")).toBe(false);
    expect(parseBool("")).toBe(false);
    expect(parseBool(undefined as any)).toBe(false);
  });

  test("parseNum cases", () => {
    expect(parseNum("5", 0)).toBe(5);
    expect(parseNum("0", 1)).toBe(0);
    expect(parseNum("abc" as any, 3)).toBe(3);
    expect(parseNum(undefined as any, 7)).toBe(7);
  });
});
