import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findVcsRoot } from "../src/vcs/find-root";

const TMP = join(tmpdir(), `smithers-vcs-root-test-${Date.now()}`);

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("findVcsRoot", () => {
  test("finds .git directory", () => {
    const gitDir = join(TMP, "git-project");
    mkdirSync(join(gitDir, ".git"), { recursive: true });
    mkdirSync(join(gitDir, "src", "deep"), { recursive: true });

    const result = findVcsRoot(join(gitDir, "src", "deep"));
    expect(result).toBeDefined();
    expect(result!.type).toBe("git");
    expect(result!.root).toBe(gitDir);
  });

  test("finds .jj directory", () => {
    const jjDir = join(TMP, "jj-project");
    mkdirSync(join(jjDir, ".jj"), { recursive: true });
    mkdirSync(join(jjDir, "src"), { recursive: true });

    const result = findVcsRoot(join(jjDir, "src"));
    expect(result).toBeDefined();
    expect(result!.type).toBe("jj");
    expect(result!.root).toBe(jjDir);
  });

  test("prefers .jj over .git (colocated repo)", () => {
    const colocated = join(TMP, "colocated");
    mkdirSync(join(colocated, ".jj"), { recursive: true });
    mkdirSync(join(colocated, ".git"), { recursive: true });

    const result = findVcsRoot(colocated);
    expect(result).toBeDefined();
    expect(result!.type).toBe("jj");
  });

  test("returns undefined for directory with no VCS", () => {
    const noVcs = join(TMP, "no-vcs");
    mkdirSync(noVcs, { recursive: true });

    const result = findVcsRoot(noVcs);
    expect(result).toBeNull();
  });

  test("finds VCS root from deeply nested path", () => {
    const project = join(TMP, "deep-project");
    mkdirSync(join(project, ".git"), { recursive: true });
    const deepPath = join(project, "a", "b", "c", "d", "e");
    mkdirSync(deepPath, { recursive: true });

    const result = findVcsRoot(deepPath);
    expect(result).toBeDefined();
    expect(result!.root).toBe(project);
  });

  test("finds VCS root when starting from root itself", () => {
    const project = join(TMP, "root-start");
    mkdirSync(join(project, ".git"), { recursive: true });

    const result = findVcsRoot(project);
    expect(result).toBeDefined();
    expect(result!.root).toBe(project);
  });
});
