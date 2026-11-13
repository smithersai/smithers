import { minimatch } from "minimatch"
import { describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as Review from "../src/LlmLint.ts"
import * as Target from "../src/Target.ts"
import { plannedCalls } from "./plan.ts"

describe("review authoring and public receipts", () => {
  it("forwards explicit limits and required-review policy while preserving literal file inputs", () => {
    const context = Input.glob("docs/**/*.md")
    const budget = { modelCalls: 2, promptTokens: 10000, wallMs: 60000 }
    const target = Review.LlmLint({
      changes: Input.gitDiff({ base: "HEAD", paths: ["src/**"] }),
      include: [Input.file("src/a[1].ts")],
      context: [Input.file("docs/a[1].md"), context],
      deps: [],
      prompt: "Review",
      rubric: "Defects",
      model: "fixture",
      batchSize: 1,
      contextTokens: Review.minimumContextTokens,
      required: true,
      budget,
      manual: true
    })
    const call = plannedCalls(target)[0]!
    expect(call.action).toBe("smithers-build/llm-review")
    expect(call.payload).toMatchObject({
      context: [expect.anything(), context],
      contextTokens: Review.minimumContextTokens,
      required: true,
      budget
    })
    const [include] = call.payload.include as ReadonlyArray<Input.Glob>
    expect(minimatch("src/a[1].ts", include!.pattern)).toBe(true)
    expect(minimatch("src/a1.ts", include!.pattern)).toBe(false)
    const [fileContext] = call.payload.context as ReadonlyArray<Input.Glob>
    expect(minimatch("docs/a[1].md", fileContext!.pattern)).toBe(true)
    expect(minimatch("docs/a1.md", fileContext!.pattern)).toBe(false)
    expect(Target.metadata(target).manual).toBe(true)
  })

  it.each([undefined, "maintainer"])(
    "keeps owner metadata optional without disclosing open finding details: %s",
    (owner) => {
      const record = Review.FindingRecord.make({
        fingerprint: "fixture-fingerprint",
        ...(owner === undefined ? {} : { owner }),
        policy: "fixture-policy",
        state: "open",
        reproductionSteps: "restricted reproduction",
        firstSeenRun: "first",
        lastSeenRun: "last",
        updatedAt: "now",
        finding: { file: "private/location.ts", line: 1, severity: "warning", message: "restricted finding detail" }
      })
      expect(Review.publicSummary(record)).toEqual({
        fingerprint: "fixture-fingerprint",
        reference: "restricted-finding:fixture-fingerprint",
        state: "open",
        severity: "warning",
        ...(owner === undefined ? {} : { owner })
      })
    }
  )
})
