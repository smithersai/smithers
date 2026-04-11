import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSandboxPath, assertPathWithinRoot } from "@smithers/tools/utils";

describe("resolveSandboxPath", () => {
  const root = mkdtempSync(join(tmpdir(), "sandbox-"));

  test("resolves relative path within root", () => {
    const result = resolveSandboxPath(root, "foo/bar.txt");
    expect(result).toBe(join(root, "foo/bar.txt"));
  });

  test("resolves absolute path within root", () => {
    const abs = join(root, "nested/file.ts");
    expect(resolveSandboxPath(root, abs)).toBe(abs);
  });

  test("rejects path traversal with ../", () => {
    expect(() => resolveSandboxPath(root, "../../../etc/passwd")).toThrow(
      "Path escapes sandbox root",
    );
  });

  test("rejects absolute path outside root", () => {
    expect(() => resolveSandboxPath(root, "/etc/passwd")).toThrow(
      "Path escapes sandbox root",
    );
  });

  test("rejects empty string", () => {
    expect(() => resolveSandboxPath(root, "")).toThrow("Path must be a string");
  });

  test("rejects non-string input", () => {
    expect(() => resolveSandboxPath(root, null as any)).toThrow(
      "Path must be a string",
    );
    expect(() => resolveSandboxPath(root, undefined as any)).toThrow(
      "Path must be a string",
    );
  });

  test("allows root path itself", () => {
    expect(resolveSandboxPath(root, root)).toBe(root);
  });
});

describe("assertPathWithinRoot", () => {
  test("accepts path within root", async () => {
    const root = mkdtempSync(join(tmpdir(), "sandbox-"));
    const file = join(root, "test.txt");
    writeFileSync(file, "test");
    await expect(assertPathWithinRoot(root, file)).resolves.toBeUndefined();
  });

  test("rejects symlink escaping root", async () => {
    const root = mkdtempSync(join(tmpdir(), "sandbox-"));
    const target = mkdtempSync(join(tmpdir(), "escape-"));
    writeFileSync(join(target, "secret"), "data");
    const link = join(root, "escape");
    symlinkSync(target, link);
    await expect(
      assertPathWithinRoot(root, join(link, "secret")),
    ).rejects.toThrow("Path escapes sandbox root");
  });

  test("accepts non-existent path within root (walks parents)", async () => {
    const root = mkdtempSync(join(tmpdir(), "sandbox-"));
    const nonexistent = join(root, "a", "b", "c.txt");
    await expect(
      assertPathWithinRoot(root, nonexistent),
    ).resolves.toBeUndefined();
  });
});
