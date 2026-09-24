import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mergeBase } from "../git/mergeBase.ts";
import { runCommand } from "../git/runCommand.ts";
import { runGit } from "../git/runGit.ts";
import { reviewMode } from "./reviewMode.ts";
import type { FileFilter } from "./fileFilter.ts";
import type { OpenCodeReviewInput } from "../workflow/openCodeReviewInputSchema.ts";
import type { ReviewWarning } from "../workflow/reviewWarningSchema.ts";

const REPO_RULE = ".opencodereview/rule.json";

type RuleFile = { label: string; text: string };

function readDiskRule(label: string, path: string): RuleFile | null {
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return null;
  return { label, text: readFileSync(path, "utf8") };
}

// The revision whose rule governs a review. Range and commit mode review a
// change its author controls, so the change's own rule file never applies.
async function ruleRevision(repoDir: string, input: OpenCodeReviewInput) {
  const mode = reviewMode(input);
  if (mode === "range") return mergeBase(repoDir, input.from, input.to);
  if (mode === "commit") {
    const parent = await runCommand("git", ["rev-parse", "--verify", "--quiet", `${input.commit.trim()}^1^{commit}`], repoDir);
    // A root commit has no parent, so there is no rule it did not write.
    return parent.exitCode === 0 ? parent.stdout.trim() : null;
  }
  return "worktree";
}

async function readRepoRule(repoDir: string, input: OpenCodeReviewInput): Promise<RuleFile | null> {
  const rev = await ruleRevision(repoDir, input);
  if (rev === null) return null;
  if (rev === "worktree") return readDiskRule(REPO_RULE, join(repoDir, REPO_RULE));
  const entry = (await runGit(repoDir, ["ls-tree", "--end-of-options", rev, "--", REPO_RULE])).trim();
  const [, type, sha] = entry.split(/\s+/);
  if (type !== "blob" || !sha) return null;
  return { label: REPO_RULE, text: await runGit(repoDir, ["cat-file", "blob", sha]) };
}

function parseRule(file: RuleFile, warnings: Array<ReviewWarning>): FileFilter | null {
  let raw: unknown;
  try {
    raw = JSON.parse(file.text);
  } catch {
    raw = undefined;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push({ file: file.label, type: "rule_invalid", message: "Not a JSON object; rule ignored." });
    return null;
  }
  const record = raw as Record<string, unknown>;
  const globs = (value: unknown) =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").map((v) => v.toLowerCase()) : [];
  return { include: globs(record.include), exclude: globs(record.exclude) };
}

/**
 * Picks the first non-empty rule: `--rule`, then the repository's
 * `.opencodereview/rule.json`, then the one in the home directory.
 *
 * In range and commit mode the repository rule is read from the base
 * revision, so the change under review cannot narrow its own review. A rule
 * that does not parse is skipped with a `rule_invalid` warning.
 */
export async function buildFileFilter(
  repoDir: string,
  input: OpenCodeReviewInput,
): Promise<{ filter: FileFilter | null; warnings: Array<ReviewWarning> }> {
  const customRulePath = input.rule.trim();
  const files = [
    customRulePath ? readDiskRule(customRulePath, resolve(customRulePath)) : null,
    await readRepoRule(repoDir, input),
    readDiskRule(`~/${REPO_RULE}`, join(homedir(), REPO_RULE)),
  ];
  const warnings: Array<ReviewWarning> = [];
  for (const file of files) {
    const rule = file && parseRule(file, warnings);
    if (rule && (rule.include.length > 0 || rule.exclude.length > 0)) return { filter: rule, warnings };
  }
  return { filter: null, warnings };
}
