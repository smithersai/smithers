import { join, resolve } from "node:path"
import { type Revisions, revisionsFor } from "../git/revisions.ts"
import { io, runIo } from "../io.ts"
import type { OpenCodeReviewInput } from "../workflow/openCodeReviewInputSchema.vibe"
import type { ReviewWarning } from "../workflow/reviewWarningSchema.ts"
import type { FileFilter } from "./fileFilter.ts"
import { reviewMode } from "./reviewMode.ts"

const REPO_RULE = ".opencodereview/rule.json"

type RuleFile = { label: string; text: string }

async function readDiskRule(label: string, path: string): Promise<RuleFile | null> {
  const fs = io().fs
  if (!await runIo(fs.exists(path))) return null
  if ((await runIo(fs.stat(path))).type !== "File") return null
  return { label, text: await runIo(fs.readFileString(path)) }
}

// The revision whose rule governs a review. Range and commit mode review a
// change its author controls, so the change's own rule file never applies.
// A root commit has no parent, so there is no rule it did not write.
async function ruleRevision(revisions: Revisions, input: OpenCodeReviewInput) {
  const mode = reviewMode(input)
  if (mode === "range") return revisions.forkPoint(input.from.trim(), input.to.trim())
  if (mode === "commit") return revisions.parent(input.commit.trim())
  return "worktree"
}

async function readRepoRule(repoDir: string, input: OpenCodeReviewInput): Promise<RuleFile | null> {
  const revisions = await revisionsFor(repoDir)
  const rev = await ruleRevision(revisions, input)
  if (rev === null) return null
  if (rev === "worktree") return readDiskRule(REPO_RULE, join(repoDir, REPO_RULE))
  const text = await revisions.fileAt(rev, REPO_RULE)
  return text === null ? null : { label: REPO_RULE, text }
}

function parseRule(file: RuleFile, warnings: Array<ReviewWarning>): FileFilter | null {
  let raw: unknown
  try {
    raw = JSON.parse(file.text)
  } catch {
    raw = undefined
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push({ file: file.label, type: "rule_invalid", message: "Not a JSON object; rule ignored." })
    return null
  }
  const record = raw as Record<string, unknown>
  const globs = (value: unknown) =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").map((v) => v.toLowerCase()) : []
  return { include: globs(record.include), exclude: globs(record.exclude) }
}

/**
 * Picks the first non-empty rule: `--rule`, then the repository's
 * `.opencodereview/rule.json`, with host filesystem permissions.
 *
 * In range and commit mode the repository rule is read from the base
 * revision, so the change under review cannot narrow its own review. A rule
 * that does not parse is skipped with a `rule_invalid` warning.
 */
export async function buildFileFilter(
  repoDir: string,
  input: OpenCodeReviewInput
): Promise<{ filter: FileFilter | null; warnings: Array<ReviewWarning> }> {
  const customRulePath = input.rule.trim()
  const files = [
    customRulePath ? await readDiskRule(customRulePath, resolve(customRulePath)) : null,
    await readRepoRule(repoDir, input)
  ]
  const warnings: Array<ReviewWarning> = []
  for (const file of files) {
    const rule = file && parseRule(file, warnings)
    if (rule && (rule.include.length > 0 || rule.exclude.length > 0)) return { filter: rule, warnings }
  }
  return { filter: null, warnings }
}
