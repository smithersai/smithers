import { describe, expect, test } from "bun:test";
import { sha256Hex } from "../src/utils/hash";

describe("sha256Hex", () => {
  test("returns hex string", () => {
    const hash = sha256Hex("hello");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("same input produces same output", () => {
    expect(sha256Hex("test")).toBe(sha256Hex("test"));
  });

  test("different input produces different output", () => {
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });

  test("empty string has known hash", () => {
    const hash = sha256Hex("");
    // SHA256 of empty string is well-known
    expect(hash).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("handles unicode input", () => {
    const hash = sha256Hex("hello 🌍");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("handles long input", () => {
    const longStr = "x".repeat(100000);
    const hash = sha256Hex(longStr);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
