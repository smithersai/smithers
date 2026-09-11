import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "./runCommand.ts";
import { runGit } from "./runGit.ts";
import { parseGitDiff } from "./parseGitDiff.ts";
import { effectivePath } from "./effectivePath.ts";
import { globMatch } from "../review/globMatch.ts";
import { reviewMode } from "../review/reviewMode.ts";
import type { OpenCodeReviewInput } from "../workflow/openCodeReviewInputSchema.ts";

const DIFF_CONTEXT_LINES = 3;

const providerDirIgnoreDirs = [
  ".idea/",
  ".vscode/",
  ".svn/",
  ".git/",
  "vendor/",
  "node_modules/",
  "target/",
  ".happypack/",
  ".cachefile/",
  "_packages/",
  "rpm/",
  "pkgs/",
];

function loadGitignorePatterns(repoDir: string) {
  const path = join(repoDir, ".gitignore");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function gitignorePatternMatches(pattern: string, relPath: string) {
  if (pattern.startsWith("!")) return false;
  if (pattern.endsWith("/")) {
    const dirName = pattern.slice(0, -1);
    return relPath.split("/").includes(dirName);
  }
  if (!pattern.includes("/")) {
    return globMatch(pattern, relPath.split("/").pop() ?? relPath);
  }
  return globMatch(pattern, relPath) || relPath.endsWith(pattern);
}

function isProviderExcluded(path: string, gitignorePatterns: string[]) {
  for (const prefix of providerDirIgnoreDirs) {
    const dirPart = prefix.replace(/\/$/, "");
    if (path === dirPart || path.startsWith(prefix)) return true;
  }
  return gitignorePatterns.some((pattern) => gitignorePatternMatches(pattern, path));
}

/**
 * Reads one untracked path the way Git records it, never following a symlink.
 *
 * A symlink contributes its target text, so a link that points outside the
 * repository can never copy the linked file's bytes into a review diff.
 * Anything that is not a regular file (directory, fifo, socket, device)
 * contributes nothing.
 */
function readUntrackedBody(fullPath: string): { isSymlink: boolean; text: string } | null {
  const entry = lstatSync(fullPath, { throwIfNoEntry: false });
  if (entry === undefined) return null;
  if (entry.isSymbolicLink()) return { isSymlink: true, text: readlinkSync(fullPath) };
  if (!entry.isFile()) return null;
  // O_NOFOLLOW closes the window between lstat and open: a path swapped for a
  // symlink after the check fails to open instead of reading the link target.
  let fd: number;
  try {
    fd = openSync(fullPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    return { isSymlink: false, text: readFileSync(fd).toString("utf8") };
  } finally {
    closeSync(fd);
  }
}

async function workspaceDiffText(repoDir: string) {
  let tracked = "";
  const trackedResult = await runCommand(
    "git",
    ["-c", "core.quotepath=false", "diff", "HEAD", "--no-color", `-U${DIFF_CONTEXT_LINES}`, "--"],
    repoDir,
  );
  if (trackedResult.exitCode === 0 && trackedResult.stdout !== "") {
    tracked = trackedResult.stdout;
  } else {
    tracked = await runGit(repoDir, ["diff", "--staged", "--no-color", `-U${DIFF_CONTEXT_LINES}`, "--"]);
  }

  const untracked = await runGit(repoDir, ["ls-files", "--others", "--exclude-standard"]);
  const pieces = [tracked];
  for (const relPath of untracked
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)) {
    const body = readUntrackedBody(join(repoDir, relPath));
    if (body === null) continue;
    const text = body.text;
    const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
    const lineCount = text.length === 0 ? 0 : lines.length;
    const addedLines = text.length > 0 ? lines.map((line) => `+${line}`) : [];
    const diffLines = [`diff --git a/${relPath} b/${relPath}`];
    if (body.isSymlink) diffLines.push("new file mode 120000");
    diffLines.push("--- /dev/null", `+++ b/${relPath}`, `@@ -0,0 +1,${lineCount} @@`, ...addedLines);
    pieces.push(diffLines.join("\n"));
  }
  return pieces.filter(Boolean).join("\n\n");
}

/**
 * Reads the change set from git and parses it into one record per file.
 *
 * @since 1.0.0
 * @category constructors
 */
export async function loadDiffs(repoDir: string, input: OpenCodeReviewInput) {
  const mode = reviewMode(input);
  let diffText = "";
  if (mode === "range") {
    const base = (await runGit(repoDir, ["merge-base", "--end-of-options", input.from.trim(), input.to.trim()])).trim();
    if (!base) throw new Error(`Cannot find merge-base between ${input.from} and ${input.to}.`);
    diffText = await runGit(repoDir, [
      "diff",
      "--no-color",
      `-U${DIFF_CONTEXT_LINES}`,
      "--end-of-options",
      base,
      input.to.trim(),
      "--",
    ]);
  } else if (mode === "commit") {
    diffText = await runGit(repoDir, [
      "show",
      "--no-color",
      `-U${DIFF_CONTEXT_LINES}`,
      "--end-of-options",
      input.commit.trim(),
    ]);
  } else {
    diffText = await workspaceDiffText(repoDir);
  }

  const gitignorePatterns = loadGitignorePatterns(repoDir);
  return parseGitDiff(diffText).filter((diff) => !isProviderExcluded(effectivePath(diff), gitignorePatterns));
}
