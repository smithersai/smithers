import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.ts"
import { layer, TestSharderJudge } from "../../../examples/use-cases/test-sharder-judge.vibe"

const directory = mkdtempSync(join(tmpdir(), "test-sharder-judge-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const diff = [
  "+++ b/src/cart.ts",
  "+export const total = 3",
  "+++ b/src/price.ts",
  "+export const tax = 0.2"
].join("\n")

/**
 * An analyzer that lists the files the diff touches; a selector that picks one
 * test per changed file and defers `src/legacy.test.ts`; runners that fail the
 * tests in `failing` and answer off-schema for the ones in `broken`; and an
 * adjudicator that goes red on a failure, yellow when a selected test has no
 * result, else green. Each request is recorded in order of arrival.
 */
const script = (
  options: { readonly failing?: ReadonlyArray<string>; readonly broken?: ReadonlyArray<string> } = {}
) => {
  const asked: Record<string, Array<string>> = { analyze: [], select: [], run: [], adjudicate: [] }
  let selected = 0
  const answer: Kit.Script = (text) => {
    const analyze = /Analyze this change against (.+)\.\n\nDiff:\n/.exec(text)
    if (analyze !== null) {
      asked.analyze!.push(analyze[1]!)
      return {
        changedFiles: [...text.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]),
        affectedModules: ["checkout"],
        riskLevel: "medium"
      }
    }
    const select = /Select the tests to run first among (.+)\.\n\nChanged files: (.+)\n/.exec(text)
    if (select !== null) {
      asked.select!.push(`${select[1]} for ${select[2]}`)
      const changed: ReadonlyArray<string> = JSON.parse(select[2]!)
      selected = changed.length
      return {
        priorityTests: changed.map((file) => ({
          file: file.replace(/\.ts$/, ".test.ts"),
          reason: `covers ${file}`,
          confidence: 0.9
        })),
        deferredTests: ["src/legacy.test.ts"],
        totalCandidates: changed.length + 1
      }
    }
    const run = /Run the test file (.+) with (.+)\.\nSelected because: (.+)/.exec(text)
    if (run !== null) {
      const file = run[1]!
      asked.run!.push(`${file} with ${run[2]} (${run[3]})`)
      if (options.broken?.includes(file)) return { unexpected: true }
      return options.failing?.includes(file)
        ? { testFile: file, status: "fail", durationMs: 120, errorMessage: "expected 3 to equal 4" }
        : { testFile: file, status: "pass", durationMs: 80 }
    }
    const adjudicate = /Risk level: (.+)\nResults: (.+)\nDeferred tests: (.+)/.exec(text)
    if (adjudicate !== null && text.includes("Adjudicate the test results")) {
      const results: ReadonlyArray<{ readonly testFile: string; readonly status: string }> = JSON.parse(adjudicate[2]!)
      const deferred: ReadonlyArray<string> = JSON.parse(adjudicate[3]!)
      asked.adjudicate!.push(`${adjudicate[1]}: ${results.map((r) => `${r.testFile}=${r.status}`).join(", ")}`)
      const failed = results.filter((result) => result.status === "fail").map((result) => result.testFile)
      const missing = results.length < selected
      return {
        verdict: failed.length > 0 ? "red" : missing ? "yellow" : "green",
        failedTests: failed,
        deferredTests: deferred,
        shouldExpandRun: missing,
        summary: `${failed.length} of ${results.length} selected tests broke`
      }
    }
    return undefined
  }
  return { answer, asked }
}

it.effect("runs one shard per selected test and adjudicates the combined results", () =>
  Effect.gen(function*() {
    const { answer, asked } = script({ failing: ["src/cart.test.ts"] })
    const verdict = yield* Kit.run(TestSharderJudge, { diff }, {
      filename: join(directory, "red.sqlite"),
      executionId: "test-sharder-judge-red",
      script: answer,
      actions: layer
    })

    expect(asked.analyze).toEqual(["main"])
    // The selector read the files the analyzer found in the diff.
    expect(asked.select).toEqual(["**/*.test.{ts,tsx} for [\"src/cart.ts\",\"src/price.ts\"]"])
    expect([...asked.run!].sort()).toEqual([
      "src/cart.test.ts with npx vitest run (covers src/cart.ts)",
      "src/price.test.ts with npx vitest run (covers src/price.ts)"
    ])
    // The adjudicator read every shard's result, in selection order, and the analyzer's risk.
    expect(asked.adjudicate).toEqual(["medium: src/cart.test.ts=fail, src/price.test.ts=pass"])
    expect(verdict).toEqual({
      verdict: "red",
      failedTests: ["src/cart.test.ts"],
      deferredTests: ["src/legacy.test.ts"],
      shouldExpandRun: false,
      summary: "1 of 2 selected tests broke"
    })
  }))

it.effect("drops a failed runner's result and adjudicates the rest", () =>
  Effect.gen(function*() {
    const { answer, asked } = script({ broken: ["src/price.test.ts"] })
    const verdict = yield* Kit.run(TestSharderJudge, {
      diff,
      baseBranch: "release",
      testGlob: "test/**/*.spec.ts",
      runner: "pnpm vitest run",
      maxConcurrency: 1
    }, {
      filename: join(directory, "dropped.sqlite"),
      executionId: "test-sharder-judge-dropped",
      script: answer,
      actions: layer
    })

    expect(asked.analyze).toEqual(["release"])
    expect(asked.select![0]).toMatch(/^test\/\*\*\/\*\.spec\.ts for /)
    // The broken runner was asked (and re-asked for a correction) and then dropped.
    expect(asked.run).toContain("src/price.test.ts with pnpm vitest run (covers src/price.ts)")
    expect(asked.adjudicate).toEqual(["medium: src/cart.test.ts=pass"])
    expect(verdict).toEqual({
      verdict: "yellow",
      failedTests: [],
      deferredTests: ["src/legacy.test.ts"],
      shouldExpandRun: true,
      summary: "0 of 1 selected tests broke"
    })
  }))

it.effect("adjudicates with no shards when the selector picks nothing", () =>
  Effect.gen(function*() {
    const { answer, asked } = script()
    const verdict = yield* Kit.run(TestSharderJudge, { diff: "+ a comment" }, {
      filename: join(directory, "nothing.sqlite"),
      executionId: "test-sharder-judge-nothing",
      script: answer,
      actions: layer
    })

    expect(asked.select).toEqual(["**/*.test.{ts,tsx} for []"])
    expect(asked.run).toEqual([])
    expect(asked.adjudicate).toEqual(["medium: "])
    expect(verdict.verdict).toBe("green")
  }))
