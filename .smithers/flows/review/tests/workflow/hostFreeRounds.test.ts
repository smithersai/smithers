/**
 * The rounds a host without a checkout registers import no platform module.
 *
 * A Worker reads the change set from GitHub instead of git, so it registers
 * the review rounds, their pure steps and the change-set builders, and supplies
 * its own `PrepareReview` and `RenderWalkthrough`. This walks every module those
 * entries reach through relative imports and fails on a `node:` or `bun:`
 * specifier, a bare Node built-in, or a package outside `PACKAGES`. Each listed
 * package is on the repository's browser contract
 * (`packages/repo-targets/browser/browser-contract.mjs`), whose gate proves it
 * bundles without Node; `@smthrs/agent/AgentAction` is a module of the
 * contracted `@smthrs/agent` root.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { readFileSync } from "node:fs"
import { isBuiltin } from "node:module"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { comparisonSnapshot, layer, preparedReviewOf, ReviewFiles, ReviewInput } from "../../rounds.ts"
import { host } from "../host.ts"
import { scriptedSeats } from "./scriptedSeats.ts"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

/** What a host without a checkout imports to run the rounds. */
const ENTRIES = ["rounds.ts"]

const PACKAGES = new Set(["effect", "@smthrs/flow", "@smthrs/plan", "@smthrs/agent/AgentAction"])

const allowedPackage = (specifier: string) =>
  PACKAGES.has(specifier) || (specifier.startsWith("effect/") && !specifier.startsWith("effect/unstable/"))

/** Every specifier the compiler reads as a module reference in `file`. */
const specifiers = (file: string) =>
  ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles.map((reference) => reference.fileName)

/** The disallowed imports reachable from `entries`, each with the chain that reaches it. */
function platformImports(entries: ReadonlyArray<string>): Array<string> {
  const parent = new Map<string, string>()
  const queue = entries.map((entry) => resolve(root, entry))
  for (const file of queue) parent.set(file, "")
  const found: Array<string> = []
  const chain = (file: string) => {
    const files: Array<string> = []
    for (let at = file; at; at = parent.get(at) ?? "") files.unshift(relative(root, at))
    return files.join(" -> ")
  }
  while (queue.length > 0) {
    const file = queue.shift()!
    for (const specifier of specifiers(file)) {
      if (specifier.startsWith(".")) {
        const next = resolve(dirname(file), specifier)
        if (!parent.has(next)) {
          parent.set(next, file)
          queue.push(next)
        }
      } else if (specifier.startsWith("node:") || specifier.startsWith("bun:") || isBuiltin(specifier)) {
        found.push(`${specifier} <- ${chain(file)}`)
      } else if (!allowedPackage(specifier)) {
        found.push(`${specifier} (not on the browser contract) <- ${chain(file)}`)
      }
    }
  }
  return found
}

describe("the rounds a host without a checkout registers", () => {
  test("reach no platform module", () => {
    expect(platformImports(ENTRIES)).toEqual([])
  })

  test("the walk sees the host implementations' platform imports", () => {
    const found = platformImports(["src/workflow/reviewHostActions.ts"])
    expect(found).toContain("node:async_hooks <- src/workflow/reviewHostActions.ts -> src/io.ts")
    expect(found.some((line) => line.startsWith("node:path <- "))).toBe(true)
  })
})

describe("the package root's rounds", () => {
  test("review a GitHub comparison and render no walkthrough", async () => {
    const finding = {
      path: "src/a.ts",
      content: "The second binding repeats the first.",
      severity: "major",
      category: "correctness",
      confidence: "confirmed",
      startLine: 2,
      endLine: 2,
      existingCode: "",
      suggestionCode: "",
      thinking: ""
    }
    const answer = (ask: string) =>
      ask.includes("adjudicate code-review findings")
        ? { verdicts: [{ index: 0, verdict: "keep", reason: "the diff shows it" }] }
        : { status: "success", message: "", summary: null, comments: [finding], warnings: [] }
    const input = Schema.decodeUnknownSync(ReviewInput)({ narrate: false })
    const snapshot = comparisonSnapshot({
      input,
      repository: "acme/widgets",
      base: "a".repeat(40),
      head: "b".repeat(40),
      files: [{
        filename: "src/a.ts",
        status: "added",
        additions: 2,
        deletions: 0,
        patch: "@@ -0,0 +1,2 @@\n+export const a = 1\n+export const a2 = a"
      }],
      truncated: false
    })
    const result = await Effect.runPromise(
      ReviewFiles.execute({ input, prepared: preparedReviewOf(snapshot), offset: 0, outcomes: [] }, {
        executionId: `rounds-${Math.random()}`
      }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(host(scriptedSeats(answer))))), Effect.orDie)
    )
    expect(result.verdict).toBe("fail")
    expect(result.review.comments.map((comment) => [comment.path, comment.startLine])).toEqual([["src/a.ts", 2]])
    expect(result.walkthrough).toMatchObject({ path: "", bytes: 0, findings: 1 })
    expect(result.ui.html).toBe("")
  }, 120_000)
})

test("a truncated comparison stays incomplete after an empty reviewer answer", async () => {
  const asks: Array<string> = []
  const answer = (ask: string) => {
    asks.push(ask)
    return { status: "success", message: "", summary: null, comments: [], warnings: [] }
  }
  const input = Schema.decodeUnknownSync(ReviewInput)({ narrate: false })
  const snapshot = comparisonSnapshot({
    input,
    repository: "acme/widgets",
    base: "a".repeat(40),
    head: "b".repeat(40),
    files: [{
      filename: "src/large.ts",
      status: "added",
      additions: 2,
      deletions: 0,
      patch: '@@ -0,0 +1,2 @@\n+' + "x".repeat(66_000) + '\n+throw new Error("BUG_AFTER_LIMIT");'
    }, {
      filename: "src/small.ts",
      status: "added",
      additions: 1,
      deletions: 0,
      patch: "@@ -0,0 +1 @@\n+export const ok = 1"
    }],
    truncated: false
  })
  const result = await Effect.runPromise(
    ReviewFiles.execute({ input, prepared: preparedReviewOf(snapshot), offset: 0, outcomes: [] }, {
      executionId: `truncated-rounds-${Math.random()}`
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(host(scriptedSeats(answer))))), Effect.orDie)
  )
  expect(asks).toHaveLength(2)
  expect(asks.some((ask) => ask.includes("[diff truncated for prompt size]"))).toBe(true)
  expect(asks.every((ask) => !ask.includes("BUG_AFTER_LIMIT"))).toBe(true)
  expect(result.verdict).toBe("incomplete")
  expect(result.review.status).toBe("completed_with_warnings")
  expect(result.review.summary?.filesReviewed).toBe(1)
  expect(result.review.warnings).toContainEqual(expect.objectContaining({
    file: "src/large.ts",
    type: "diff_truncated",
    message: expect.stringContaining("were not reviewed")
  }))
  expect(result.review.comments).toEqual([])
}, 120_000)
