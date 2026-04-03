import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { resolveSandboxPath } from "../src/tools/utils";

const TMP = join(tmpdir(), `smithers-sandbox-test-${Date.now()}`);

beforeAll(() => {
  mkdirSync(join(TMP, "sub"), { recursive: true });
  writeFileSync(join(TMP, "file.txt"), "hello");
  writeFileSync(join(TMP, "sub", "nested.txt"), "nested");
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("resolveSandboxPath", () => {
  test("resolves relative path within root", () => {
    const result = resolveSandboxPath(TMP, "file.txt");
    expect(result).toBe(join(TMP, "file.txt"));
  });

  test("resolves nested relative path", () => {
    const result = resolveSandboxPath(TMP, "sub/nested.txt");
    expect(result).toBe(join(TMP, "sub", "nested.txt"));
  });

  test("resolves absolute path within root", () => {
    const abs = join(TMP, "file.txt");
    const result = resolveSandboxPath(TMP, abs);
    expect(result).toBe(abs);
  });

  test("allows root directory itself", () => {
    const result = resolveSandboxPath(TMP, TMP);
    expect(result).toBe(TMP);
  });

  test("blocks path traversal with ..", () => {
    expect(() => resolveSandboxPath(TMP, "../../../etc/passwd")).toThrow(
      /escapes sandbox/,
    );
  });

  test("blocks absolute path outside root", () => {
    expect(() => resolveSandboxPath(TMP, "/etc/passwd")).toThrow(
      /escapes sandbox/,
    );
  });

  test("throws for empty string input", () => {
    expect(() => resolveSandboxPath(TMP, "")).toThrow(/Path must be a string/);
  });

  test("throws for non-string input", () => {
    expect(() => resolveSandboxPath(TMP, null as any)).toThrow(
      /Path must be a string/,
    );
  });

  test("throws for undefined input", () => {
    expect(() => resolveSandboxPath(TMP, undefined as any)).toThrow(
      /Path must be a string/,
    );
  });

  test("resolves . to root directory", () => {
    const result = resolveSandboxPath(TMP, ".");
    expect(result).toBe(TMP);
  });

  test("handles paths with trailing separator", () => {
    const result = resolveSandboxPath(TMP, "sub/");
    expect(result).toBe(join(TMP, "sub"));
  });

  test("blocks sibling directory traversal", () => {
    // Try to escape to a sibling: /tmp/foo/../bar
    expect(() => resolveSandboxPath(TMP, join("..", "other-dir"))).toThrow(
      /escapes sandbox/,
    );
  });
});
