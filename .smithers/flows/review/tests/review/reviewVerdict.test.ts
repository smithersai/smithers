import { describe, expect, test } from "bun:test"
import * as Schema from "effect/Schema"
import { BLOCKING_SEVERITY, reviewVerdict } from "../../src/review/reviewVerdict.ts"
import { ReviewCommentSeverity } from "../../src/workflow/reviewCommentSeveritySchema.ts"
import { ReviewRunOutput } from "../../src/workflow/reviewRunOutputSchema.ts"
import { ReviewRunStatus } from "../../src/workflow/reviewRunStatusSchema.ts"
import { ReviewResult } from "../../src/workflow/reviewSchemas.vibe"

const review = (fields: Record<string, unknown>) =>
  Schema.decodeUnknownSync(ReviewRunOutput)({ status: "success", ok: true, ...fields })
const finding = (severity: string) => ({ path: "a.ts", content: "a finding", severity })

describe("reviewVerdict", () => {
  test("a whole review passes with no finding, or only findings below major", () => {
    expect(BLOCKING_SEVERITY).toBe("major")
    expect(reviewVerdict(review({}))).toBe("pass")
    expect(reviewVerdict(review({ comments: [finding("minor"), finding("info")] }))).toBe("pass")
  })

  test("every severity at or above major fails; every one below passes", () => {
    const expected: Record<string, string> = { critical: "fail", major: "fail", minor: "pass", info: "pass" }
    expect(ReviewCommentSeverity.literals).toEqual(["critical", "major", "minor", "info"])
    const verdicts = ReviewCommentSeverity.literals.map((severity) =>
      `${severity} ${reviewVerdict(review({ comments: [finding("info"), finding(severity)] }))}`
    )
    expect(verdicts).toEqual(ReviewCommentSeverity.literals.map((severity) => `${severity} ${expected[severity]}`))
  })

  test("every status but success is incomplete, with or without a blocking finding", () => {
    for (const status of ReviewRunStatus.literals.filter((status) => status !== "success")) {
      for (const comments of [[], [finding("critical")]]) {
        expect([status, reviewVerdict(review({ status, comments }))]).toEqual([status, "incomplete"])
      }
    }
  })

  test("unverified findings are incomplete; a verifier that ruled on them is not", () => {
    for (const type of ["verifier_error", "verifier_skipped"]) {
      for (const comments of [[], [finding("major")]]) {
        expect([type, reviewVerdict(review({ comments, warnings: [{ type, message: "unverified" }] }))])
          .toEqual([type, "incomplete"])
      }
    }
    const ruled = [{ type: "verifier_dropped" }, { type: "verifier_demoted" }, { type: "verifier_unknown_index" }]
    expect(reviewVerdict(review({ comments: [finding("minor")], warnings: ruled }))).toBe("pass")
    expect(reviewVerdict(review({ comments: [finding("major")], warnings: ruled }))).toBe("fail")
  })

  test("a result stored before the verdict existed decodes as incomplete", () => {
    const stored = Schema.decodeUnknownSync(ReviewResult)({
      target: { repoDir: "/r", mode: "commit", ref: "abc" },
      review: { status: "success", ok: true },
      walkthrough: { path: "/r/w.html", bytes: 1, chapters: 0, files: 0, findings: 0 },
      story: { headline: "h", synopsis: "s", chapters: [] },
      ui: { kind: "html", title: "t", html: "<p></p>" }
    })
    expect(stored.verdict).toBe("incomplete")
  })
})
