/** @jsxImportSource smithers */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  Task,
  Workflow,
  Worktree,
  createSmithers,
  runWorkflow,
} from "../src/index";
import { z } from "zod";

/**
 * Tests for https://github.com/jjhub-ai/smithers/issues/110
 *
 * ensureWorktree() should use `baseBranch` (or sensible defaults) instead of
 * hardcoded "main" / "origin/main" for syncing existing worktrees.
 */

const tempRoots: string[] = [];

afterEach(async () => {
  for (const dir of tempRoots.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function runGit(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout || "unknown error"}`,
    );
  }
  return result;
}

function hasGit() {
  return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
}

async function createReleaseOnlyGitRepo() {
  const root = await mkdtemp(join(tmpdir(), "smithers-issue110-"));
  tempRoots.push(root);

  const bareDir = join(root, "remote.git");
  await mkdir(bareDir, { recursive: true });
  runGit(bareDir, ["init", "--bare"]);

  const repoDir = join(root, "repo");
  await mkdir(repoDir, { recursive: true });
  runGit(repoDir, ["init", "-b", "release"]);
  runGit(repoDir, ["config", "user.email", "test@example.com"]);
  runGit(repoDir, ["config", "user.name", "Test"]);
  await writeFile(join(repoDir, "README.md"), "init\n", "utf8");
  runGit(repoDir, ["add", "README.md"]);
  runGit(repoDir, ["commit", "-m", "init"]);
  runGit(repoDir, ["remote", "add", "origin", bareDir]);
  runGit(repoDir, ["push", "-u", "origin", "release"]);

  return { root, repoDir, bareDir };
}

describe("Issue #110: ensureWorktree baseBranch support", () => {
  test("worktree with baseBranch='release' syncs against origin/release, not origin/main", async () => {
    if (!hasGit()) return;

    const { root, repoDir, bareDir } = await createReleaseOnlyGitRepo();
    const worktreePath = resolve(repoDir, "..", "linked-release");
    const dbPath = join(root, "db.sqlite");

    const api = createSmithers(
      { probe: z.object({ status: z.string() }) },
      { dbPath },
    );

    const workflow = api.smithers((_ctx) => (
      <Workflow name="release-base">
        <Worktree id="wt" path="../linked-release" branch="unit/demo" baseBranch="release">
          <Task id="probe" output={api.outputs.probe}>
            {{ status: "ok" }}
          </Task>
        </Worktree>
      </Workflow>
    ));

    try {
      // First run: creates the worktree (from release via fallback chain)
      const first = await runWorkflow(workflow, { input: {}, rootDir: repoDir });
      expect(first.status).toBe("finished");
      expect(existsSync(worktreePath)).toBe(true);

      // Push a new commit to origin/release so the second run has something to sync
      await writeFile(join(repoDir, "update.txt"), "new\n", "utf8");
      runGit(repoDir, ["add", "update.txt"]);
      runGit(repoDir, ["commit", "-m", "update"]);
      runGit(repoDir, ["push", "origin", "release"]);

      // Second run: should sync against origin/release, not origin/main
      const second = await runWorkflow(workflow, { input: {}, rootDir: repoDir });
      expect(second.status).toBe("finished");

      // Verify the worktree was actually rebased onto origin/release
      // by checking that update.txt exists in the worktree
      const syncWorked = existsSync(join(worktreePath, "update.txt"));
      expect(syncWorked).toBe(true);
    } finally {
      try {
        (api.db as any).$client?.close?.();
      } catch {}
    }
  });

  test("worktree without baseBranch falls back through main, origin/main, HEAD", async () => {
    if (!hasGit()) return;

    const { root, repoDir } = await createReleaseOnlyGitRepo();
    const worktreePath = resolve(repoDir, "..", "linked-fallback");
    const dbPath = join(root, "db2.sqlite");

    const api = createSmithers(
      { probe: z.object({ status: z.string() }) },
      { dbPath },
    );

    // No baseBranch — should still work via HEAD fallback
    const workflow = api.smithers((_ctx) => (
      <Workflow name="fallback-test">
        <Worktree id="wt" path="../linked-fallback" branch="unit/fb">
          <Task id="probe" output={api.outputs.probe}>
            {{ status: "ok" }}
          </Task>
        </Worktree>
      </Workflow>
    ));

    try {
      const first = await runWorkflow(workflow, { input: {}, rootDir: repoDir });
      expect(first.status).toBe("finished");
      expect(existsSync(worktreePath)).toBe(true);

      // Second run — sync path. Without baseBranch, origin/main doesn't exist,
      // but the engine should still not crash (best-effort sync with warning)
      const second = await runWorkflow(workflow, { input: {}, rootDir: repoDir });
      expect(second.status).toBe("finished");
    } finally {
      try {
        (api.db as any).$client?.close?.();
      } catch {}
    }
  });
});
