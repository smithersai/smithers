import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildNativeReviewPrompt,
  diffStatus,
  effectivePath,
  finalizeNativeReview,
  globMatch,
  loadDiffs,
  nativeReviewPromptFromSnapshot,
  normalizeOpenCodeReviewInput,
  previewFromSnapshot,
  previewOpenCodeReview,
  reviewFileTaskId,
  reviewMode,
  resolveReviewTarget,
  validateReviewInput,
  type DiffRecord,
  type NativeReviewAgentOutput,
  type NativeReviewPrompt,
  type PreviewOutput,
  type ReviewSnapshot,
} from "../../src/workflow/openCodeReview.ts";
import { changesFromDiffs } from "../../src/walkthrough/changesFromDiffs.ts";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});

function git(dir: string, args: string[]) {
  execFileSync("git", args, { cwd: dir, stdio: "pipe" });
}

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocr-unit-"));
  tempDirs.push(dir);
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "T"]);
  git(dir, ["config", "diff.renames", "true"]);
  return dir;
}

function diffRecord(overrides: Partial<DiffRecord>): DiffRecord {
  return {
    oldPath: "src/a.ts",
    newPath: "src/a.ts",
    diff: "",
    insertions: 0,
    deletions: 0,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    ...overrides,
  };
}

describe("openCodeReview pure helpers", () => {
  test("normalizeOpenCodeReviewInput strips nulls and accepts non-records", () => {
    expect(normalizeOpenCodeReviewInput({ repo: "x", from: null }).repo).toBe("x");
    // non-record input falls back to defaults
    expect(normalizeOpenCodeReviewInput(42).repo).toBe(".");
    expect(normalizeOpenCodeReviewInput(null).concurrency).toBe(8);
  });

  test("reviewMode picks commit, range, or workspace", () => {
    expect(reviewMode({ ...normalizeOpenCodeReviewInput({}), commit: "abc" })).toBe("commit");
    expect(reviewMode({ ...normalizeOpenCodeReviewInput({}), from: "a", to: "b" })).toBe("range");
    expect(reviewMode(normalizeOpenCodeReviewInput({}))).toBe("workspace");
  });

  test("validateReviewInput rejects conflicting or half-specified ranges", () => {
    expect(() => validateReviewInput({ ...normalizeOpenCodeReviewInput({}), from: "a", to: "b", commit: "c" })).toThrow(
      "Only one review mode",
    );
    expect(() => validateReviewInput({ ...normalizeOpenCodeReviewInput({}), from: "a" })).toThrow("--to is required");
    expect(() => validateReviewInput({ ...normalizeOpenCodeReviewInput({}), to: "b" })).toThrow("--from is required");
    // valid inputs do not throw
    expect(() => validateReviewInput(normalizeOpenCodeReviewInput({}))).not.toThrow();
    expect(() => validateReviewInput({ ...normalizeOpenCodeReviewInput({}), from: "a", to: "b" })).not.toThrow();
  });

  test("globMatch expands braces and honors ** / * segments", () => {
    expect(globMatch("**/*.test.{ts,tsx}", "src/deep/x.test.ts")).toBe(true);
    expect(globMatch("**/*.test.{ts,tsx}", "src/x.test.tsx")).toBe(true);
    expect(globMatch("src/*.ts", "src/a.ts")).toBe(true);
    expect(globMatch("src/*.ts", "src/deep/a.ts")).toBe(false);
    expect(globMatch("a/**", "a/b/c")).toBe(true);
    // unbalanced brace is treated literally
    expect(globMatch("a{b", "a{b")).toBe(true);
  });

  test("effectivePath prefers the new path unless it is /dev/null", () => {
    expect(effectivePath(diffRecord({ newPath: "src/new.ts", oldPath: "src/old.ts" }))).toBe("src/new.ts");
    expect(effectivePath(diffRecord({ newPath: "/dev/null", oldPath: "src/gone.ts" }))).toBe("src/gone.ts");
  });

  test("diffStatus classifies binary, added, deleted, renamed, and modified", () => {
    expect(diffStatus(diffRecord({ isBinary: true }))).toBe("binary");
    expect(diffStatus(diffRecord({ isNew: true, oldPath: "/dev/null" }))).toBe("added");
    expect(diffStatus(diffRecord({ isDeleted: true, newPath: "/dev/null" }))).toBe("deleted");
    expect(diffStatus(diffRecord({ oldPath: "src/old.ts", newPath: "src/new.ts" }))).toBe("renamed");
    expect(diffStatus(diffRecord({}))).toBe("modified");
  });

  test("reviewFileTaskId slugifies the path and falls back to 'file'", () => {
    expect(reviewFileTaskId("src/Foo Bar.ts", 0)).toBe("review-file-1-src-foo-bar-ts");
    expect(reviewFileTaskId("!!!", 3)).toBe("review-file-4-file");
  });
});

describe("snapshot builders (no git repository)", () => {
  // Absent directory: a builder that reads the tree instead of the snapshot fails here.
  const absent = "/nonexistent/ocr/path/xyz";
  function snapshotOf(diffs: Array<DiffRecord>): ReviewSnapshot {
    return {
      input: { ...normalizeOpenCodeReviewInput({}), repo: absent },
      target: { repoDir: absent, mode: "workspace", ref: "workspace" },
      filter: null,
      diffs,
    };
  }

  test("preview, prompts, and walkthrough changes all describe the given diffs", () => {
    const snapshot = snapshotOf([
      diffRecord({ diff: "@@ -1 +1 @@\n-a\n+b\n", insertions: 1, deletions: 1 }),
      diffRecord({ oldPath: "notes.md", newPath: "notes.md", diff: "@@ -1 +1 @@\n-x\n+y\n", insertions: 2, deletions: 3 }),
    ]);

    const preview = previewFromSnapshot(snapshot);
    expect(preview.entries.map((entry) => entry.path)).toEqual(["src/a.ts", "notes.md"]);
    expect(preview.totalFiles).toBe(2);
    expect(preview.totalInsertions).toBe(3);
    expect(preview.totalDeletions).toBe(4);
    expect(preview.reviewableCount).toBe(1);
    expect(preview.entries.find((entry) => entry.path === "notes.md")?.excludeReason).toBe("unsupported_ext");

    const prompt = nativeReviewPromptFromSnapshot(snapshot, preview);
    expect(prompt.shouldReview).toBe(true);
    expect(prompt.repoDir).toBe(absent);
    expect(prompt.files.map((file) => file.path)).toEqual(["src/a.ts"]);
    expect(prompt.files[0]?.prompt).toContain("+b");
    expect(prompt.excludedFiles).toBe(1);

    const changes = changesFromDiffs(snapshot.diffs, preview);
    expect(changes.files.map((file) => file.path)).toEqual(["src/a.ts", "notes.md"]);
    expect(changes.files.find((file) => file.path === "notes.md")?.reviewed).toBe(false);
    expect(changes.files.find((file) => file.path === "src/a.ts")?.reviewed).toBe(true);
    expect(changes.totalFiles).toBe(2);
    expect(changes.totalInsertions).toBe(3);
  });

  test("prompts short-circuit without reading the tree when nothing is reviewable", () => {
    const snapshot = snapshotOf([diffRecord({ oldPath: "notes.md", newPath: "notes.md", insertions: 1 })]);
    const preview = previewFromSnapshot(snapshot);
    expect(preview.reviewableCount).toBe(0);
    const prompt = nativeReviewPromptFromSnapshot(snapshot, preview);
    expect(prompt.shouldReview).toBe(false);
    expect(prompt.message).toContain("No supported files changed");

    const disabled = nativeReviewPromptFromSnapshot(
      { ...snapshot, input: { ...snapshot.input, runReview: false } },
      previewFromSnapshot(snapshotOf([diffRecord({ insertions: 1 })])),
    );
    expect(disabled.shouldReview).toBe(false);
    expect(disabled.message).toContain("runReview");
  });
});

describe("resolveReviewTarget", () => {
  test("throws when the directory is not a git repo (spawn error handler)", async () => {
    // A non-existent cwd makes the git spawn emit an 'error' event → exitCode 127
    // → git() throws, exercising runCommand's error branch.
    await expect(
      resolveReviewTarget({ ...normalizeOpenCodeReviewInput({}), repo: "/nonexistent/ocr/path/xyz" }),
    ).rejects.toThrow();
  });

  test("resolves workspace/range/commit refs in a real repo", async () => {
    const dir = initRepo();
    write(join(dir, "src/app.ts"), "export const v = 1;\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "init"]);
    const workspace = await resolveReviewTarget({ ...normalizeOpenCodeReviewInput({}), repo: dir });
    expect(workspace.mode).toBe("workspace");
    expect(workspace.ref).toBe("workspace");
    const commit = await resolveReviewTarget({ ...normalizeOpenCodeReviewInput({}), repo: dir, commit: "HEAD" });
    expect(commit.mode).toBe("commit");
    expect(commit.ref).toBe("HEAD");
    const range = await resolveReviewTarget({
      ...normalizeOpenCodeReviewInput({}),
      repo: dir,
      from: "HEAD",
      to: "HEAD",
    });
    expect(range.mode).toBe("range");
    expect(range.ref).toBe("HEAD..HEAD");
  });
});

describe("previewOpenCodeReview + buildNativeReviewPrompt (real git)", () => {
  test("workspace mode: tracked modification, untracked files, filters, checklists, big diff", async () => {
    const dir = initRepo();
    write(join(dir, "src/app.ts"), "export const v = 1;\n");
    write(join(dir, "src/keep.ts"), "export const keep = 1;\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "init"]);

    // Tracked modification so `git diff HEAD` is non-empty.
    write(join(dir, "src/app.ts"), "export const v = 1;\nexport const w = 2;\n");
    // Delete a committed file → exercises the deleted-file diff parsing + prompt.
    rmSync(join(dir, "src/keep.ts"));
    // Untracked files across languages/kinds to exercise checklist selection.
    write(join(dir, "src/util.ts"), "export const util = () => 42;\n");
    write(join(dir, "src/tests/helper.ts"), "export const help = 1;\n"); // reviewable test-dir file → test checklist
    write(join(dir, "e2e/flow.ts"), "export const flow = 1;\n"); // e2e dir is a test path for every consumer
    write(join(dir, "src/app.test.ts"), "test('x', () => {});\n"); // test-file checklist + default exclude
    write(join(dir, "config.json"), '{"a":1}\n'); // json/yaml checklist
    write(join(dir, "notes.md"), "# notes\n"); // unsupported ext → excluded, default checklist path
    write(join(dir, "src/big.ts"), `export const big = "${"x".repeat(70_000)}";\n`); // trimDiff truncation at the reviewer limit
    // node_modules provider-excluded path.
    write(join(dir, "node_modules/dep.js"), "module.exports = 1;\n");
    // .gitignore with negation, dir, no-slash, and slash patterns (all non-matching for src/app.ts).
    write(join(dir, ".gitignore"), "!keep.ts\nbuildonly/\n*.tmplog\nsrc/never-there.ts\n");

    const preview = await previewOpenCodeReview({ ...normalizeOpenCodeReviewInput({}), repo: dir });
    expect(preview.totalFiles).toBeGreaterThan(0);
    expect(preview.reviewableCount).toBeGreaterThan(0);
    // notes.md is unsupported-ext excluded; node_modules is provider excluded.
    const paths = preview.entries.map((e) => e.path);
    expect(paths).toContain("src/app.ts");
    expect(paths).not.toContain("node_modules/dep.js");
    const md = preview.entries.find((e) => e.path === "notes.md");
    expect(md?.willReview).toBe(false);
    expect(md?.excludeReason).toBe("unsupported_ext");
    const testFile = preview.entries.find((e) => e.path === "src/app.test.ts");
    expect(testFile?.willReview).toBe(false);

    const prompt = await buildNativeReviewPrompt({ ...normalizeOpenCodeReviewInput({}), repo: dir }, preview);
    expect(prompt.shouldReview).toBe(true);
    expect(prompt.files.length).toBe(preview.reviewableCount);
    const appFile = prompt.files.find((f) => f.path === "src/app.ts");
    expect(appFile?.prompt).toContain("Review checklist:");
    // The seat gets a noop registry, so the prompt states the diff-only contract.
    expect(appFile?.prompt).toContain("You have no repository access and no tools");
    expect(appFile?.prompt).not.toContain("Your working directory is the repository");
    // "Other changed files" lists the sibling reviewable files.
    expect(appFile?.prompt).toContain("Other changed files:");
    const bigFile = prompt.files.find((f) => f.path === "src/big.ts");
    expect(bigFile?.prompt).toContain("[diff truncated for prompt size]");
    // The deleted file is reviewable and carries the deletion-focused prompt.
    const deleted = prompt.files.find((f) => f.path === "src/keep.ts");
    expect(deleted?.status).toBe("deleted");
    expect(deleted?.prompt).toContain("This file is DELETED");
    expect(deleted?.prompt).not.toContain("Grep the repository");
    // The test-dir file selects the test-quality checklist.
    const helper = prompt.files.find((f) => f.path === "src/tests/helper.ts");
    expect(helper?.prompt).toContain("Test quality:");
    const e2e = prompt.files.find((f) => f.path === "e2e/flow.ts");
    expect(e2e?.prompt).toContain("Test quality:");
  });

  test("buildNativeReviewPrompt reports no reviewable files when a stale preview disagrees", async () => {
    const dir = initRepo();
    write(join(dir, "README.md"), "# docs only\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "init"]);
    write(join(dir, "README.md"), "# docs only\nmore\n");
    // Hand-built preview claims a reviewable file, but the repo has only an
    // unsupported doc change → reviewableDiffs resolves to empty.
    const stalePreview: PreviewOutput = {
      entries: [
        { path: "README.md", status: "modified", insertions: 1, deletions: 0, willReview: true, excludeReason: "" },
      ],
      totalInsertions: 1,
      totalDeletions: 0,
      totalFiles: 1,
      reviewableCount: 1,
      excludedCount: 0,
    };
    const prompt = await buildNativeReviewPrompt({ ...normalizeOpenCodeReviewInput({}), repo: dir }, stalePreview);
    expect(prompt.shouldReview).toBe(false);
    expect(prompt.message).toContain("No supported files changed");
  });

  test("workspace mode renders untracked symlinks as their target, never the linked file", async () => {
    const dir = initRepo();
    write(join(dir, "src/app.ts"), "export const v = 1;\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "init"]);

    // A readable file outside the repository, reachable only through a link.
    const outside = mkdtempSync(join(tmpdir(), "ocr-outside-"));
    tempDirs.push(outside);
    const secretPath = join(outside, "credentials.txt");
    writeFileSync(secretPath, "DUMMY_SECRET_OUTSIDE_REPO\n");
    symlinkSync(secretPath, join(dir, "src/leak.ts"));
    symlinkSync(join(outside, "absent.txt"), join(dir, "src/broken.ts"));
    symlinkSync(outside, join(dir, "src/linkdir.ts"));
    write(join(dir, "src/plain.ts"), "export const plain = 1;\n");

    const diffs = await loadDiffs(dir, { ...normalizeOpenCodeReviewInput({}), repo: dir });
    const whole = diffs.map((d) => d.diff).join("\n");
    expect(whole).not.toContain("DUMMY_SECRET_OUTSIDE_REPO");

    const leak = diffs.find((d) => effectivePath(d) === "src/leak.ts");
    expect(leak?.diff).toContain("new file mode 120000");
    expect(leak?.diff).toContain(`+${secretPath}`);
    // A dangling link still renders; it must not throw or read anything.
    const broken = diffs.find((d) => effectivePath(d) === "src/broken.ts");
    expect(broken?.diff).toContain("new file mode 120000");
    expect(broken?.diff).toContain(`+${join(outside, "absent.txt")}`);
    // A link to a directory is not walked into.
    const linkDir = diffs.find((d) => effectivePath(d) === "src/linkdir.ts");
    expect(linkDir?.diff).toContain("new file mode 120000");
    // Ordinary untracked files still contribute their contents.
    const plain = diffs.find((d) => effectivePath(d) === "src/plain.ts");
    expect(plain?.diff).toContain("+export const plain = 1;");
    expect(plain?.diff).not.toContain("new file mode 120000");
  });

  test("workspace mode with only untracked changes falls through to the staged-diff branch", async () => {
    const dir = initRepo();
    write(join(dir, "src/app.ts"), "export const v = 1;\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "init"]);
    // No tracked modification → `git diff HEAD` empty → staged-diff fallback.
    write(join(dir, "src/fresh.ts"), "export const fresh = 1;\n");
    const preview = await previewOpenCodeReview({ ...normalizeOpenCodeReviewInput({}), repo: dir });
    expect(preview.entries.some((e) => e.path === "src/fresh.ts")).toBe(true);
  });

  test("range and commit modes read their diffs", async () => {
    const dir = initRepo();
    write(join(dir, "src/app.ts"), "export const v = 1;\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "init"]);
    write(join(dir, "src/app.ts"), "export const v = 1;\nexport const w = 2;\n");
    write(join(dir, "src/added.ts"), "export const added = 1;\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "second"]);

    const range = await previewOpenCodeReview({
      ...normalizeOpenCodeReviewInput({}),
      repo: dir,
      from: "HEAD~1",
      to: "HEAD",
    });
    expect(range.totalFiles).toBeGreaterThan(0);
    const commit = await previewOpenCodeReview({ ...normalizeOpenCodeReviewInput({}), repo: dir, commit: "HEAD" });
    expect(commit.totalFiles).toBeGreaterThan(0);
  });

  test("project rule.json include/exclude filters via --rule and repo config", async () => {
    const dir = initRepo();
    write(join(dir, "src/app.ts"), "export const v = 1;\n");
    write(join(dir, "src/skip.ts"), "export const skip = 1;\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "init"]);
    write(join(dir, "src/app.ts"), "export const v = 1;\nexport const w = 2;\n");
    write(join(dir, "src/skip.ts"), "export const skip = 1;\nexport const q = 2;\n");
    // A --rule path that is a non-object JSON → readProjectRule returns null.
    const badRule = join(dir, "bad-rule.json");
    write(badRule, "[]");
    // The repo-level rule provides the real include/exclude.
    write(
      join(dir, ".opencodereview/rule.json"),
      JSON.stringify({ include: ["src/app.ts"], exclude: ["src/skip.ts"] }),
    );

    const preview = await previewOpenCodeReview({ ...normalizeOpenCodeReviewInput({}), repo: dir, rule: badRule });
    const skip = preview.entries.find((e) => e.path === "src/skip.ts");
    expect(skip?.willReview).toBe(false);
    expect(skip?.excludeReason).toBe("user_exclude");
    const app = preview.entries.find((e) => e.path === "src/app.ts");
    expect(app?.willReview).toBe(true);
  });

  test("buildNativeReviewPrompt short-circuits when runReview is false or nothing is reviewable", async () => {
    const dir = initRepo();
    write(join(dir, "README.md"), "# only docs\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "init"]);
    write(join(dir, "README.md"), "# only docs\nmore\n");

    const preview = await previewOpenCodeReview({ ...normalizeOpenCodeReviewInput({}), repo: dir });
    // runReview disabled → shouldReview false.
    const disabled = await buildNativeReviewPrompt(
      { ...normalizeOpenCodeReviewInput({}), repo: dir, runReview: false },
      preview,
    );
    expect(disabled.shouldReview).toBe(false);
    expect(disabled.message).toContain("disabled");

    // Only an unsupported doc changed → reviewableCount 0.
    const nothing = await buildNativeReviewPrompt({ ...normalizeOpenCodeReviewInput({}), repo: dir }, preview);
    expect(nothing.shouldReview).toBe(false);
    expect(nothing.message).toContain("No supported files changed");
  });
});

describe("finalizeNativeReview", () => {
  const diffText = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,4 @@",
    " const keep = 1;",
    "-const removed = 2;",
    "+const added = 2;",
    "+const more = 3;",
    " const tail = 4;",
  ].join("\n");

  function prepared(files: Array<{ id: string; path: string; diff: string }>): NativeReviewPrompt {
    return {
      shouldReview: true,
      repoDir: "/repo",
      mode: "workspace",
      ref: "workspace",
      reviewableFiles: files.length,
      excludedFiles: 0,
      files: files.map((f) => ({
        id: f.id,
        path: f.path,
        status: "modified",
        insertions: 2,
        deletions: 1,
        diff: f.diff,
        prompt: "",
      })),
      message: "prepared",
    };
  }

  function preview(paths: string[]): PreviewOutput {
    return {
      entries: paths.map((path) => ({
        path,
        status: "modified",
        insertions: 2,
        deletions: 1,
        willReview: true,
        excludeReason: "",
      })),
      totalInsertions: 2 * paths.length,
      totalDeletions: paths.length,
      totalFiles: paths.length,
      reviewableCount: paths.length,
      excludedCount: 0,
    };
  }

  const baseInput = normalizeOpenCodeReviewInput({});

  const emptyOutput: NativeReviewAgentOutput = {
    status: "success",
    message: "",
    summary: null,
    warnings: [],
    comments: [],
  };
  const finding = {
    path: "",
    content: "Unsafe call needs a guard",
    suggestionCode: "safeA();",
    existingCode: "unsafeA();",
    startLine: 0,
    endLine: 0,
    thinking: "",
    severity: "major" as const,
    category: "correctness" as const,
    confidence: "confirmed" as const,
  };

  test("rejects a finding naming another reviewable file before anchoring", () => {
    const p = prepared([
      { id: "a", path: "src/a.ts", diff: "@@ -0,0 +1 @@\n+unsafeA();" },
      { id: "b", path: "src/b.ts", diff: "@@ -0,0 +1 @@\n+safeB();" },
    ]);
    const out = finalizeNativeReview(baseInput, p, preview(["src/a.ts", "src/b.ts"]), [
      { file: p.files[1], output: emptyOutput },
      {
        file: p.files[0],
        output: { ...emptyOutput, comments: [{ ...finding, path: " src/b.ts " }, finding] },
      },
    ]);
    expect(out.comments).toHaveLength(1);
    expect(out.comments[0]).toMatchObject({
      path: "src/a.ts",
      startLine: 1,
      endLine: 1,
      suggestionCode: "safeA();",
    });
    expect(out.warnings).toContainEqual({
      file: "src/a.ts",
      type: "out_of_scope_comment",
      message: "Dropped comment targeting src/b.ts from review of src/a.ts.",
    });
  });

  for (const status of ["success", "completed_with_warnings", "completed_with_errors", "failed"] as const) {
    for (const hasWarnings of [false, true]) {
      test(`preserves ${status} with ${hasWarnings ? "populated" : "empty"} warnings`, () => {
        const p = prepared([{ id: "a", path: "src/a.ts", diff: diffText }]);
        const warnings = hasWarnings ? [{ file: "src/a.ts", type: "note", message: "agent note" }] : [];
        const out = finalizeNativeReview(baseInput, p, preview(["src/a.ts"]), [
          {
            file: p.files[0],
            output: { ...emptyOutput, status, message: `seat: ${status}`, warnings },
          },
        ]);
        expect(out.status).toBe(
          status === "failed"
            ? "failed"
            : status !== "success" || hasWarnings
              ? "completed_with_warnings"
              : "success",
        );
        expect(out.ok).toBe(status !== "failed");
        for (const warning of warnings) expect(out.warnings).toContainEqual(warning);
        if (status !== "success") {
          expect(out.warnings).toContainEqual({
            file: "src/a.ts",
            type: status === "completed_with_warnings" ? "subtask_warning" : "subtask_error",
            message: `seat: ${status}`,
          });
          expect(out.message).not.toContain("Looks good to me");
        }
      });
    }
  }

  for (const status of ["completed_with_warnings", "completed_with_errors"] as const) {
    test(`supplies a diagnostic when ${status} has no message`, () => {
      const p = prepared([{ id: "a", path: "src/a.ts", diff: diffText }]);
      const out = finalizeNativeReview(baseInput, p, preview(["src/a.ts"]), [
        {
          file: p.files[0],
          output: { ...emptyOutput, status, message: "  " },
        },
      ]);
      expect(out.status).toBe("completed_with_warnings");
      expect(out.warnings).toContainEqual({
        file: "src/a.ts",
        type: status === "completed_with_warnings" ? "subtask_warning" : "subtask_error",
        message: `Native Smithers file review ${status.replaceAll("_", " ")}.`,
      });
    });
  }

  test("counts added prefix increments before anchoring following code", () => {
    const p = prepared([
      {
        id: "a",
        path: "src/a.ts",
        diff: "--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1,2 @@\n+++counter;\n+unsafeA();",
      },
    ]);
    const out = finalizeNativeReview(baseInput, p, preview(["src/a.ts"]), [
      {
        file: p.files[0],
        output: { ...emptyOutput, comments: [finding] },
      },
    ]);
    expect(out.comments[0]).toMatchObject({ startLine: 2, endLine: 2 });
  });

  test("keeps removed SQL comments when matching existingCode on the old side", () => {
    const p = prepared([
      {
        id: "a",
        path: "src/a.ts",
        diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1 @@\n--- comment\n unsafeA();",
      },
    ]);
    const out = finalizeNativeReview(baseInput, p, preview(["src/a.ts"]), [
      {
        file: p.files[0],
        output: { ...emptyOutput, comments: [{ ...finding, existingCode: "-- comment\nunsafeA();" }] },
      },
    ]);
    expect(out.comments[0]).toMatchObject({ startLine: 1, endLine: 1 });
  });

  test("returns skipped when the prompt says not to review", () => {
    const out = finalizeNativeReview(
      baseInput,
      { ...prepared([{ id: "f1", path: "src/a.ts", diff: diffText }]), shouldReview: false, message: "nope" },
      preview(["src/a.ts"]),
      [],
    );
    expect(out.status).toBe("skipped");
    expect(out.ok).toBe(true);
    expect(out.message).toBe("nope");
  });

  test("anchors, dedupes, drops out-of-scope, and reports warnings", () => {
    const p = prepared([{ id: "f1", path: "src/a.ts", diff: diffText }]);
    const out = finalizeNativeReview(baseInput, p, preview(["src/a.ts"]), [
      {
        file: p.files[0],
        output: {
          status: "completed_with_warnings",
          message: "",
          summary: null,
          warnings: [{ file: "src/a.ts", message: "agent note", type: "note" }],
          comments: [
            // explicit line, within the new-side range → kept as-is
            {
              path: "",
              content: "Added constant is unused",
              suggestionCode: "",
              existingCode: "",
              startLine: 2,
              endLine: 3,
              thinking: "  reasoned  ",
              severity: "major",
              category: "correctness",
              confidence: "confirmed",
            },
            // resolved from existingCode on the new side
            {
              path: "src/a.ts",
              content: "another finding via existingCode",
              suggestionCode: "const added = safe();",
              existingCode: "const more = 3;",
              startLine: 0,
              endLine: 0,
              thinking: "",
              severity: "minor",
              category: "other",
              confidence: "plausible",
            },
            // near-duplicate of the first (overlapping lines, near-identical text) → deduped
            {
              path: "src/a.ts",
              content: "Added constant is unused!!",
              suggestionCode: "",
              existingCode: "",
              startLine: 2,
              endLine: 2,
              thinking: "",
              severity: "critical",
              category: "correctness",
              confidence: "confirmed",
            },
            // out-of-scope path → dropped
            {
              path: "elsewhere/x.ts",
              content: "not in scope",
              suggestionCode: "",
              existingCode: "",
              startLine: 1,
              endLine: 1,
              thinking: "",
              severity: "info",
              category: "other",
              confidence: "plausible",
            },
          ],
        },
      },
    ]);
    expect(out.status).toBe("completed_with_warnings");
    expect(out.comments.length).toBeGreaterThan(0);
    // The near-duplicate kept the highest severity (critical) copy.
    expect(out.comments.some((c) => c.severity === "critical")).toBe(true);
    // Warnings mention the out-of-scope drop and the duplicate drop.
    expect(out.warnings.some((w) => w.type === "out_of_scope_comment")).toBe(true);
    expect(out.warnings.some((w) => w.type === "duplicate_comment")).toBe(true);
    // The existingCode-resolved comment anchored to a real new-side line.
    const resolved = out.comments.find((c) => c.content.includes("existingCode"));
    expect(resolved?.startLine).toBeGreaterThan(0);
  });

  test("resolves deleted-line existingCode and zeroes anchors that cannot resolve", () => {
    const p = prepared([{ id: "f1", path: "src/a.ts", diff: diffText }]);
    const out = finalizeNativeReview(baseInput, p, preview(["src/a.ts"]), [
      {
        file: p.files[0],
        output: {
          status: "success",
          message: "",
          summary: null,
          warnings: [],
          comments: [
            // existingCode matches only a DELETED line → resolves via the old-side pass
            {
              path: "src/a.ts",
              content: "removed line concern",
              suggestionCode: "",
              existingCode: "const removed = 2;",
              startLine: 0,
              endLine: 0,
              thinking: "",
              severity: "minor",
              category: "other",
              confidence: "plausible",
            },
            // agent-supplied line outside the diff and no resolvable existingCode → zeroed
            {
              path: "src/a.ts",
              content: "bogus line",
              suggestionCode: "",
              existingCode: "does not appear anywhere",
              startLine: 999,
              endLine: 999,
              thinking: "",
              severity: "info",
              category: "other",
              confidence: "plausible",
            },
          ],
        },
      },
    ]);
    const zeroed = out.comments.find((c) => c.content === "bogus line");
    expect(zeroed?.startLine).toBe(0);
    expect(zeroed?.endLine).toBe(0);
  });

  test("an explicitly paired output completes its prepared file", () => {
    const p = prepared([{ id: "f1", path: "src/a.ts", diff: diffText }]);
    const out = finalizeNativeReview(baseInput, p, preview(["src/a.ts"]), [
      { file: p.files[0], output: { ...emptyOutput, message: "ok" } },
    ]);
    // No comments, no warnings → success.
    expect(out.status).toBe("success");
    expect(out.message).toContain("No comments generated");
  });

  test("an explicitly null file output fails the run", () => {
    const p = prepared([{ id: "f1", path: "src/a.ts", diff: diffText }]);
    const out = finalizeNativeReview(baseInput, p, preview(["src/a.ts"]), [
      { file: p.files[0], output: null },
    ]);
    expect(out.status).toBe("failed");
    expect(out.warnings[0].file).toBe("src/a.ts");
  });

  test("a missing per-file output is a subtask_error and, if total, fails the run", () => {
    const p = prepared([{ id: "f1", path: "src/a.ts", diff: diffText }]);
    // No outputs → the one file has no output → failedFiles == files.length → failed.
    const out = finalizeNativeReview(baseInput, p, preview(["src/a.ts"]), []);
    expect(out.status).toBe("failed");
    expect(out.ok).toBe(false);
    expect(out.warnings.some((w) => w.type === "subtask_error")).toBe(true);
    expect(out.error).toContain("failed");
  });

  test("an explicit failed status on a single file fails the run", () => {
    const p = prepared([{ id: "f1", path: "src/a.ts", diff: diffText }]);
    const out = finalizeNativeReview(baseInput, p, preview(["src/a.ts"]), [
      { file: p.files[0], output: { ...emptyOutput, status: "failed", message: "agent exploded" } },
    ]);
    expect(out.status).toBe("failed");
    expect(out.warnings.some((w) => w.message.includes("agent exploded"))).toBe(true);
  });

  test("near-identical (not identical) comments dedupe via edit-distance; equal-severity comments sort by path then line", () => {
    const p = prepared([
      { id: "f1", path: "src/a.ts", diff: diffText },
      { id: "f2", path: "src/b.ts", diff: diffText },
    ]);
    const out = finalizeNativeReview(baseInput, p, preview(["src/a.ts", "src/b.ts"]), [
      {
        file: p.files[0],
        output: {
          status: "success",
          message: "",
          summary: null,
          warnings: [],
          comments: [
            // two same-severity findings on distinct paths → sort compares paths
            {
              path: "src/a.ts",
              content: "The value here is off by one",
              suggestionCode: "",
              existingCode: "",
              startLine: 3,
              endLine: 3,
              thinking: "",
              severity: "minor",
              category: "other",
              confidence: "plausible",
            },
            // near-identical to the first, overlapping line (3), one char different →
            // edit-distance similarity ≥ 0.9 → deduped.
            {
              path: "src/a.ts",
              content: "The value here is off by ane",
              suggestionCode: "",
              existingCode: "",
              startLine: 3,
              endLine: 3,
              thinking: "",
              severity: "minor",
              category: "other",
              confidence: "plausible",
            },
            // same path + severity, different line, distinct content → kept, sorts by startLine
            {
              path: "src/a.ts",
              content: "A totally separate concern about tail",
              suggestionCode: "",
              existingCode: "",
              startLine: 2,
              endLine: 2,
              thinking: "",
              severity: "minor",
              category: "other",
              confidence: "plausible",
            },
          ],
        },
      },
      {
        file: p.files[1],
        output: {
          status: "success",
          message: "",
          summary: null,
          warnings: [],
          comments: [
            {
              path: "src/b.ts",
              content: "b file concern unrelated entirely",
              suggestionCode: "",
              existingCode: "",
              startLine: 3,
              endLine: 3,
              thinking: "",
              severity: "minor",
              category: "other",
              confidence: "plausible",
            },
          ],
        },
      },
    ]);
    // The near-duplicate was dropped (3 in → 3 kept: a@2, a@3, b@3).
    expect(out.warnings.some((w) => w.type === "duplicate_comment")).toBe(true);
    const aComments = out.comments.filter((c) => c.path === "src/a.ts");
    expect(aComments).toHaveLength(2);
    // Same severity, same path → sorted ascending by startLine.
    expect(aComments[0].startLine).toBeLessThan(aComments[1].startLine);
    // src/a.ts sorts before src/b.ts at equal severity.
    expect(out.comments[0].path).toBe("src/a.ts");
    expect(out.comments.at(-1)?.path).toBe("src/b.ts");
  });

  test("a missing file result preserves completed files and warns", () => {
    const p = prepared([
      { id: "f1", path: "src/a.ts", diff: diffText },
      { id: "f2", path: "src/b.ts", diff: diffText },
    ]);
    const out = finalizeNativeReview(baseInput, p, preview(["src/a.ts", "src/b.ts"]), [
      { file: p.files[1], output: emptyOutput },
    ]);
    expect(out.status).toBe("completed_with_warnings");
    expect(out.warnings).toEqual([
      {
        file: "src/a.ts",
        type: "subtask_error",
        message: "Native Smithers file review did not produce output.",
      },
    ]);
  });
});
