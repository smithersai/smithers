import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CodeReviewLoop, layer, maxIterations } from "../../../examples/use-cases/code-review-loop.vibe"
import * as Kit from "../../../examples/use-cases/kit.ts"

const directory = mkdtempSync(join(tmpdir(), "code-review-loop-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/**
 * A reviewer that approves its `approveOn`-th review and otherwise raises one
 * numbered issue, and a fixer that names the issues it was handed. Every
 * request is recorded in order, with the issue text it carried.
 */
const script = (approveOn: number) => {
  const turns: Array<string> = []
  let reviews = 0
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You are a senior code reviewer")) {
      turns.push(`review: ${/Previous issues that were supposedly fixed:\n(.+)/.exec(asked)?.[1] ?? "initial"}`)
      const n = ++reviews
      return n >= approveOn
        ? { approved: true, feedback: "LGTM" }
        : { approved: false, feedback: `round ${n} needs work`, issues: [`missing null check ${n}`] }
    }
    if (asked.includes("You are a senior software engineer")) {
      const issue = /Issues to fix:\n(.+)/.exec(asked)?.[1] ?? ""
      turns.push(`fix: ${issue}`)
      return { filesChanged: ["src/parse.ts"], changesSummary: `guard for ${issue}` }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("stops at the round the reviewer approves", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(2)
    const output = yield* Kit.run(CodeReviewLoop, { directory: "src", focus: "error handling" }, {
      filename: join(directory, "approved.sqlite"),
      executionId: "code-review-approved",
      script: answer,
      actions: layer
    })

    // The second review ran after the fix and was told the first review's issue.
    expect(turns).toEqual(["review: initial", "fix: missing null check 1", "review: missing null check 1"])
    expect(output).toEqual({ finalSummary: "Code review passed - LGTM!", totalIterations: 2 })
  }))

it.effect("ends after three rounds when the reviewer never approves", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(99)
    const output = yield* Kit.run(CodeReviewLoop, { directory: "src", focus: "error handling" }, {
      filename: join(directory, "exhausted.sqlite"),
      executionId: "code-review-exhausted",
      script: answer,
      actions: layer
    })

    // Every round reviewed and then fixed, the last fix included, as in 0.x.
    expect(turns).toEqual([
      "review: initial",
      "fix: missing null check 1",
      "review: missing null check 1",
      "fix: missing null check 2",
      "review: missing null check 2",
      "fix: missing null check 3"
    ])
    expect(output).toEqual({ finalSummary: `Review completed after ${maxIterations} iterations`, totalIterations: 3 })
  }))
