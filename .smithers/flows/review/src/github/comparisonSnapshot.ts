/**
 * The change set a review reads, from GitHub's comparison of two commits
 * instead of from a checkout.
 *
 * A host without a checkout (the hosted app's Worker) already holds
 * `GET /repos/{owner}/{repo}/compare/{base}...{head}`'s `files`. This turns
 * them into the same `ReviewSnapshot` `loadReviewSnapshot` reads from git, so
 * `preparedReviewOf` and every round after it run unchanged.
 *
 * @since 1.0.0
 */
import type { DiffRecord } from "../git/diffRecord.ts"
import type { ReviewSnapshot } from "../review/reviewSnapshot.ts"
import { normalizeOpenCodeReviewInput } from "../workflow/normalizeOpenCodeReviewInput.ts"
import type { OpenCodeReviewInput } from "../workflow/openCodeReviewInputSchema.ts"

/**
 * One changed file as GitHub's compare API lists it: the fields
 * `GitHub.Commits.ChangedFile` (`@smthrs/integrations`) decodes. `patch` is
 * absent for a binary file and for a diff GitHub finds too large to show.
 *
 * @since 1.0.0
 * @category models
 */
export type ComparedFile = {
  readonly filename: string
  readonly status: string
  readonly additions: number
  readonly deletions: number
  readonly patch?: string | undefined
  readonly previous_filename?: string | undefined
}

/**
 * What a comparison hands the review.
 *
 * @since 1.0.0
 * @category models
 */
export type Comparison = {
  /** The review's request; its `repo`, `from`, `to` and `commit` are replaced by the comparison's. */
  readonly input: OpenCodeReviewInput
  /** `owner/name`, which prompts name as the repository. */
  readonly repository: string
  readonly base: string
  readonly head: string
  readonly files: ReadonlyArray<ComparedFile>
  /** GitHub listed as many files as one comparison holds, and may have left some out. */
  readonly truncated: boolean
}

/** Statuses whose file can change with no content change, which git prints as a header with no hunks. */
const HEADER_ONLY = new Set(["renamed", "copied", "changed", "unchanged"])

/**
 * One file as the diff record git's diff of the same change gives: the same
 * paths, flags and counts. GitHub's `patch` is the hunks git prints after a
 * file's header, so `diff` is that header (without the index and mode lines
 * GitHub does not report) followed by the patch.
 *
 * A file with no patch is binary when it is one whose content changed and
 * GitHub counts no lines: a binary file's shape. An empty file added or removed
 * looks the same and is skipped with it, which loses nothing to review. A
 * file with no patch and counted lines is a text diff GitHub withheld.
 */
function diffRecordOf(file: ComparedFile): DiffRecord {
  const isNew = file.status === "added"
  const isDeleted = file.status === "removed"
  const from = file.previous_filename ?? file.filename
  const oldPath = isNew ? "/dev/null" : from
  const newPath = isDeleted ? "/dev/null" : file.filename
  const patch = file.patch ?? ""
  const counted = file.additions + file.deletions > 0
  const isBinary = patch === "" && !counted && !HEADER_ONLY.has(file.status)
  const patchWithheld = patch === "" && counted
  const lines = [`diff --git a/${from} b/${file.filename}`]
  if (from !== file.filename) {
    const verb = file.status === "copied" ? "copy" : "rename"
    lines.push(`${verb} from ${from}`, `${verb} to ${file.filename}`)
  }
  const oldSide = isNew ? "/dev/null" : `a/${from}`
  const newSide = isDeleted ? "/dev/null" : `b/${file.filename}`
  if (isBinary) lines.push(`Binary files ${oldSide} and ${newSide} differ`)
  if (patch !== "") lines.push(`--- ${oldSide}`, `+++ ${newSide}`, patch.replace(/\n$/, ""))
  return {
    oldPath,
    newPath,
    diff: lines.join("\n"),
    insertions: file.additions,
    deletions: file.deletions,
    isNew,
    isDeleted,
    isBinary,
    ...(patchWithheld ? { patchWithheld } : {})
  }
}

/**
 * The review snapshot of a GitHub comparison: a `range` review of
 * `base..head`, every listed file as a diff record, and a warning when GitHub
 * may have left files out.
 *
 * The repository's `.opencodereview/rule.json` is not read: a comparison holds
 * no file contents, so only the default filters apply.
 *
 * @since 1.0.0
 * @category constructors
 */
export function comparisonSnapshot(comparison: Comparison): ReviewSnapshot {
  const input = normalizeOpenCodeReviewInput({
    ...comparison.input,
    repo: comparison.repository,
    from: comparison.base,
    to: comparison.head,
    commit: ""
  })
  return {
    input,
    target: { repoDir: comparison.repository, mode: "range", ref: `${comparison.base}..${comparison.head}` },
    filter: null,
    warnings: comparison.truncated
      ? [{
        file: "",
        type: "comparison_truncated",
        message: `GitHub listed only the first ${comparison.files.length} changed files; the rest were not reviewed.`
      }]
      : [],
    diffs: comparison.files.map(diffRecordOf)
  }
}
