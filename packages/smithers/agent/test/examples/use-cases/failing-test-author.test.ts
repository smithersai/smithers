import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FailingTestAuthor, layer, RunTest } from "../../../examples/use-cases/failing-test-author.vibe"
import * as Kit from "../../../examples/use-cases/kit.vibe"

const directory = mkdtempSync(join(tmpdir(), "failing-test-author-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/**
 * An issue reader that names the issue's endpoint as the component, an author
 * that writes `<testDir>/<component>.test.ts`, and a run step whose test fails
 * when `fails` is set. Every request is recorded in order with the values it
 * was handed.
 */
const script = (fails: boolean) => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You are a bug triage specialist")) {
      const issue = JSON.parse(/\nIssue: (.+)/.exec(asked)![1]!)
      turns.push(`analyze: ${JSON.stringify(issue)}`)
      const component = issue.endpoint ?? "unknown"
      return {
        component,
        reproSteps: [`call ${component} with a zoned date`],
        expectedBehavior: "keeps the zone",
        actualBehavior: issue.description ?? "unknown",
        summary: `${component} drops data`
      }
    }
    if (asked.includes("You are a test engineer")) {
      const testDir = /Write a failing test in (\S+)\./.exec(asked)![1]
      const component = /\nComponent: (.+)/.exec(asked)![1]
      const steps = /\nReproduction steps: (.+)/.exec(asked)![1]
      turns.push(`author: ${component} in ${testDir} after ${steps}`)
      return {
        testPath: `${testDir}/${component}.test.ts`,
        testName: `${component} keeps the zone`,
        assertion: "expect(zone).toBe('UTC')",
        linesOfCode: 6,
        summary: "asserts the zone survives"
      }
    }
    return undefined
  }
  // The deterministic run step: no process, just the outcome this test chose.
  const runner = RunTest.toLayer(({ testCmd, testPath }) =>
    Effect.sync(() => {
      turns.push(`run: ${testCmd} ${testPath}`)
      return {
        testPath,
        didFail: fails,
        exitCode: fails ? 1 : 0,
        errorOutput: fails ? "expected 'UTC', received undefined" : "",
        summary: fails ? "1 failed" : "1 passed"
      }
    })
  )
  return { answer, turns, actions: Layer.mergeAll(layer, runner) }
}

it.effect("hands a test that fails to the fix as a verified repro", () =>
  Effect.gen(function*() {
    const { actions, answer, turns } = script(true)
    const report = yield* Kit.run(FailingTestAuthor, {
      issue: { title: "Dates lose their zone", description: "the zone is dropped", endpoint: "parseDate" }
    }, {
      filename: join(directory, "verified.sqlite"),
      executionId: "failing-test-author-verified",
      script: answer,
      actions
    })

    // Each step ran after the one before it and read that step's answer; the
    // author and runner got 0.x's default directory and command.
    expect(turns).toEqual([
      "analyze: {\"title\":\"Dates lose their zone\",\"description\":\"the zone is dropped\",\"endpoint\":\"parseDate\"}",
      "author: parseDate in tests after [\"call parseDate with a zoned date\"]",
      "run: npx vitest run tests/parseDate.test.ts"
    ])
    expect(report).toEqual({
      reproTestPath: "tests/parseDate.test.ts",
      verified: true,
      readyForFix: true,
      summary: "Verified failing test at tests/parseDate.test.ts — ready for fix"
    })
  }))

it.effect("holds the fix back when the new test passes", () =>
  Effect.gen(function*() {
    const { actions, answer, turns } = script(false)
    const report = yield* Kit.run(FailingTestAuthor, { testDir: "spec", testCmd: "pnpm vitest run" }, {
      filename: join(directory, "unverified.sqlite"),
      executionId: "failing-test-author-unverified",
      script: answer,
      actions
    })

    // With no issue given, the reader is handed an empty one.
    expect(turns).toEqual([
      "analyze: {}",
      "author: unknown in spec after [\"call unknown with a zoned date\"]",
      "run: pnpm vitest run spec/unknown.test.ts"
    ])
    expect(report).toEqual({
      reproTestPath: "spec/unknown.test.ts",
      verified: false,
      readyForFix: false,
      summary: "Test did not fail as expected — repro may be incomplete"
    })
  }))
