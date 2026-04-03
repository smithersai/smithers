import { describe, expect, test, afterEach } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveSandboxPath, assertPathWithinRoot } from "../src/tools/utils";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "smithers-sandbox-"));
}

describe("resolveSandboxPath", () => {
  test("resolves relative path within root", () => {
    const result = resolveSandboxPath("/root/dir", "file.txt");
    expect(result).toBe(resolve("/root/dir", "file.txt"));
  });

  test("resolves absolute path within root", () => {
    const result = resolveSandboxPath(
      "/root/dir",
      "/root/dir/sub/file.txt",
    );
    expect(result).toBe("/root/dir/sub/file.txt");
  });

  test("rejects path traversal with ..", () => {
    expect(() =>
      resolveSandboxPath("/root/dir", "../outside.txt"),
    ).toThrow("Path escapes sandbox root");
  });

  test("rejects absolute path outside root", () => {
    expect(() => resolveSandboxPath("/root/dir", "/etc/passwd")).toThrow(
      "Path escapes sandbox root",
    );
  });

  test("throws for empty string path", () => {
    expect(() => resolveSandboxPath("/root", "")).toThrow(
      "Path must be a string",
    );
  });

  test("throws for null path", () => {
    expect(() => resolveSandboxPath("/root", null as any)).toThrow(
      "Path must be a string",
    );
  });

  test("throws for number path", () => {
    expect(() => resolveSandboxPath("/root", 42 as any)).toThrow(
      "Path must be a string",
    );
  });

  test("allows path equal to root", () => {
    const result = resolveSandboxPath("/root/dir", "/root/dir");
    expect(result).toBe("/root/dir");
  });

  test("handles deeply nested relative paths", () => {
    const result = resolveSandboxPath("/root", "a/b/c/d/e.txt");
    expect(result).toBe(resolve("/root", "a/b/c/d/e.txt"));
  });

  test("rejects traversal that normalizes outside root", () => {
    expect(() =>
      resolveSandboxPath("/root/dir", "sub/../../other/file.txt"),
    ).toThrow("Path escapes sandbox root");
  });

  test("allows traversal that stays within root", () => {
    const result = resolveSandboxPath(
      "/root/dir",
      "sub/../other/file.txt",
    );
    expect(result).toBe(resolve("/root/dir", "sub/../other/file.txt"));
  });

  test("throws for undefined path", () => {
    expect(() => resolveSandboxPath("/root", undefined as any)).toThrow(
      "Path must be a string",
    );
  });
});

describe("assertPathWithinRoot", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
    dirs.length = 0;
  });

  test("allows path within root", async () => {
    const root = makeTempDir();
    dirs.push(root);
    const filePath = join(root, "test.txt");
    writeFileSync(filePath, "content");

    // Should not throw
    await assertPathWithinRoot(root, filePath);
  });

  test("rejects symlink escaping root", async () => {
    const root = makeTempDir();
    const outside = makeTempDir();
    dirs.push(root, outside);

    const linkPath = join(root, "escape");
    symlinkSync(outside, linkPath);

    await expect(assertPathWithinRoot(root, linkPath)).rejects.toThrow(
      "Path escapes sandbox root",
    );
  });

  test("allows symlink within root", async () => {
    const root = makeTempDir();
    dirs.push(root);

    const target = join(root, "real.txt");
    writeFileSync(target, "content");
    const linkPath = join(root, "link.txt");
    symlinkSync(target, linkPath);

    // Should not throw
    await assertPathWithinRoot(root, linkPath);
  });

  test("walks up to parent when file does not exist", async () => {
    const root = makeTempDir();
    dirs.push(root);

    mkdirSync(join(root, "existing"));
    const deepPath = join(root, "existing", "nonexistent", "file.txt");

    // Should not throw - walks up until it finds existing dir within root
    await assertPathWithinRoot(root, deepPath);
  });

  test("allows nested directory within root", async () => {
    const root = makeTempDir();
    dirs.push(root);

    mkdirSync(join(root, "sub", "deep"), { recursive: true });
    writeFileSync(join(root, "sub", "deep", "file.txt"), "ok");

    await assertPathWithinRoot(
      root,
      join(root, "sub", "deep", "file.txt"),
    );
  });

  test("allows root path itself", async () => {
    const root = makeTempDir();
    dirs.push(root);

    // Root path itself should be fine
    await assertPathWithinRoot(root, root);
  });
});
