/**
 * Tests for findVcsRoot — https://github.com/jjhub-ai/smithers/issues/112
 *
 * In colocated repos (both .git and .jj exist), jj should take priority
 * so ensureWorktree creates jj workspaces and getJjPointer works.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { findVcsRoot } from "../src/vcs/find-root";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "smithers-vcs-"));
}

describe("findVcsRoot", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true }); } catch {}
    }
    dirs.length = 0;
  });

  test("returns null when no VCS found", () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    expect(findVcsRoot(dir)).toBeNull();
  });

  test("detects git-only repo", () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    mkdirSync(join(dir, ".git"));
    const result = findVcsRoot(dir);
    expect(result).toEqual({ type: "git", root: dir });
  });

  test("detects jj-only repo", () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    mkdirSync(join(dir, ".jj"));
    const result = findVcsRoot(dir);
    expect(result).toEqual({ type: "jj", root: dir });
  });

  test("colocated repo (both .git and .jj) prefers jj", () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, ".jj"));
    const result = findVcsRoot(dir);
    expect(result).toEqual({ type: "jj", root: dir });
  });

  test("walks up to find VCS root from subdirectory", () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    mkdirSync(join(dir, ".jj"));
    const sub = join(dir, "a", "b", "c");
    mkdirSync(sub, { recursive: true });
    const result = findVcsRoot(sub);
    expect(result).toEqual({ type: "jj", root: dir });
  });

  test("colocated repo detected from subdirectory prefers jj", () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, ".jj"));
    const sub = join(dir, "src", "engine");
    mkdirSync(sub, { recursive: true });
    const result = findVcsRoot(sub);
    expect(result).toEqual({ type: "jj", root: dir });
  });
});
