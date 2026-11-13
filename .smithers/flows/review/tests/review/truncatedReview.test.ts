import { describe, expect, test } from "bun:test"
import { finalizeNativeReview } from "../../src/review/finalizeNativeReview.ts"
import { preparedReviewOf } from "../../src/review/preparedReviewOf.ts"
import { reviewVerdict } from "../../src/review/reviewVerdict.ts"
import type { ReviewSnapshot } from "../../src/review/reviewSnapshot.ts"
import type { NativeReviewAgentOutput } from "../../src/workflow/nativeReviewAgentOutputSchema.ts"
import { normalizeOpenCodeReviewInput } from "../../src/workflow/normalizeOpenCodeReviewInput.ts"
import { diffRecordFixture } from "../support/diffRecordFixture.ts"

const emptyOutput: NativeReviewAgentOutput = {
  status: "success",
  message: "No comments generated. Looks good to me.",
  summary: null,
  comments: [],
  warnings: []
}

function snapshotOf(length: number, kind = "modified"): ReviewSnapshot {
  const prefix = "--- a/src/large.ts\n+++ b/src/large.ts\n@@ -1 +1 @@\n-export const old = 1;\n+"
  const tail = '\n+throw new Error("BUG_AFTER_LIMIT");\n'
  const diff = prefix + "x".repeat(length - prefix.length - tail.length) + tail
  return {
    input: normalizeOpenCodeReviewInput({}),
    target: { repoDir: ".", mode: "workspace", ref: "workspace" },
    filter: null,
    warnings: [],
    diffs: [diffRecordFixture({
      oldPath: kind === "added" ? "/dev/null" : kind === "renamed" ? "src/old.ts" : "src/large.ts",
      newPath: kind === "deleted" ? "/dev/null" : "src/large.ts",
      diff,
      insertions: kind === "deleted" ? 0 : 2,
      deletions: kind === "added" ? 0 : 1,
      isDeleted: kind === "deleted",
      isNew: kind === "added"
    })]
  }
}

function finish(snapshot: ReviewSnapshot, output = emptyOutput) {
  const prepared = preparedReviewOf(snapshot)
  const review = finalizeNativeReview(
    snapshot.input,
    prepared.prompt,
    prepared.preview,
    prepared.prompt.files.map((file) => ({ file, output }))
  )
  return { prepared, review }
}

describe("truncated file review coverage", () => {
  test.each([59_999, 60_000])("a %i-character diff is fully visible and can pass", (length) => {
    const { prepared, review } = finish(snapshotOf(length))
    expect(prepared.prompt.files[0]!.prompt).toContain("BUG_AFTER_LIMIT")
    expect(prepared.prompt.files[0]!.prompt).not.toContain("[diff truncated for prompt size]")
    expect(review.status).toBe("success")
    expect(reviewVerdict(review)).toBe("pass")
    expect(review.summary?.filesReviewed).toBe(1)
    expect(review.warnings).toEqual([])
  })

  test.each([60_001, 66_134, 120_000])("a %i-character diff cannot yield a clean pass", (length) => {
    const { prepared, review } = finish(snapshotOf(length))
    expect(prepared.prompt.files[0]!.prompt).toContain("[diff truncated for prompt size]")
    expect(review.status).toBe("completed_with_warnings")
    expect(reviewVerdict(review)).toBe("incomplete")
    expect(review.ok).toBe(true)
    expect(review.summary?.filesReviewed).toBe(0)
    expect(review.message).not.toContain("Looks good to me")
    expect(review.warnings).toContainEqual({
      file: "src/large.ts",
      type: "diff_truncated",
      message: `File review prompt was truncated at 60000 of ${length} diff characters; characters 60001-${length} were not reviewed.`
    })
    if (length > 60_100) expect(prepared.prompt.files[0]!.prompt).not.toContain("BUG_AFTER_LIMIT")
  })

  test.each(["added", "deleted", "renamed"])("truncation is file-scoped for %s files", (kind) => {
    const { review } = finish(snapshotOf(66_134, kind))
    expect(reviewVerdict(review)).toBe("incomplete")
    expect(review.summary?.filesReviewed).toBe(0)
    expect(review.warnings.filter((warning) => warning.type === "diff_truncated").map((warning) => warning.file))
      .toEqual(["src/large.ts"])
  })

  test("a partial review keeps findings while counting only complete file diffs", () => {
    const snapshot = snapshotOf(66_134)
    snapshot.diffs.push(diffRecordFixture({
      oldPath: "src/small.ts",
      newPath: "src/small.ts",
      diff: "@@ -0,0 +1 @@\n+unsafe();",
      insertions: 1
    }))
    const output: NativeReviewAgentOutput = {
      ...emptyOutput,
      comments: [{
        path: "",
        content: "The call needs a guard.",
        severity: "major",
        category: "correctness",
        confidence: "confirmed",
        startLine: 1,
        endLine: 1,
        existingCode: "",
        suggestionCode: "",
        thinking: ""
      }]
    }
    const { review } = finish(snapshot, output)
    expect(review.status).toBe("completed_with_warnings")
    expect(reviewVerdict(review)).toBe("incomplete")
    expect(review.summary?.filesReviewed).toBe(1)
    expect(review.comments.map((comment) => comment.path)).toEqual(["src/large.ts", "src/small.ts"])
    expect(review.warnings.filter((warning) => warning.type === "diff_truncated")).toHaveLength(1)
    expect(review.message).not.toContain("Reviewed 2 file")
  })

  test("missing answers still fail and retain the deterministic truncation warning", () => {
    const snapshot = snapshotOf(66_134)
    const prepared = preparedReviewOf(snapshot)
    const review = finalizeNativeReview(snapshot.input, prepared.prompt, prepared.preview, [])
    expect(review.status).toBe("failed")
    expect(review.ok).toBe(false)
    expect(review.warnings.map((warning) => warning.type)).toEqual(["diff_truncated", "subtask_error"])
    expect(review.summary?.filesReviewed).toBe(0)
  })

  test("disabled review does not report a truncation that never ran", () => {
    const snapshot = snapshotOf(66_134)
    snapshot.input = { ...snapshot.input, runReview: false }
    const { review } = finish(snapshot)
    expect(review.status).toBe("skipped")
    expect(review.summary).toBeNull()
    expect(review.warnings).toEqual([])
  })
})
