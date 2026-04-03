import { describe, expect, test } from "bun:test";
import { parseBool, parseNum } from "../src/utils/parse";

describe("parseBool", () => {
  test("returns true for 'true'", () => {
    expect(parseBool("true")).toBe(true);
  });

  test("returns true for '1'", () => {
    expect(parseBool("1")).toBe(true);
  });

  test("returns false for 'false'", () => {
    expect(parseBool("false")).toBe(false);
  });

  test("returns false for '0'", () => {
    expect(parseBool("0")).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(parseBool(undefined)).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(parseBool("")).toBe(false);
  });

  test("returns false for arbitrary string", () => {
    expect(parseBool("yes")).toBe(false);
    expect(parseBool("True")).toBe(false);
    expect(parseBool("TRUE")).toBe(false);
  });
});

describe("parseNum", () => {
  test("parses integer string", () => {
    expect(parseNum("42", 0)).toBe(42);
  });

  test("parses float string", () => {
    expect(parseNum("3.14", 0)).toBe(3.14);
  });

  test("parses negative number", () => {
    expect(parseNum("-5", 0)).toBe(-5);
  });

  test("returns fallback for undefined", () => {
    expect(parseNum(undefined, 10)).toBe(10);
  });

  test("returns fallback for non-numeric string", () => {
    expect(parseNum("abc", 99)).toBe(99);
  });

  test("returns fallback for empty string", () => {
    expect(parseNum("", 7)).toBe(7);
  });

  test("parses zero", () => {
    expect(parseNum("0", 5)).toBe(0);
  });

  test("parses scientific notation", () => {
    expect(parseNum("1e3", 0)).toBe(1000);
  });
});
