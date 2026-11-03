import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.vibe"
import type { RunRequest } from "../../../examples/use-cases/playwright-test-agent.vibe"
import { layer, PlaywrightTestAgent } from "../../../examples/use-cases/playwright-test-agent.vibe"

const directory = mkdtempSync(join(tmpdir(), "playwright-test-agent-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const input = (asked: string) => JSON.parse(/\nINPUT: (.+)/.exec(asked)![1]!)

/**
 * Agents that plan one flow, generate one spec for it, heal by naming the
 * failure they were handed, and report from the attempts and runs they were
 * handed; and a host runner whose first `failing` runs fail. Every step
 * appends to one shared `log` in the order it ran.
 */
const script = (failing: number) => {
  const log: Array<string> = []
  const planned: Array<Record<string, unknown>> = []
  const ran: Array<typeof RunRequest.Type> = []
  const reported: Array<{ readonly attempts: Array<string>; readonly runs: Array<boolean>; readonly passed: boolean }> =
    []
  let heals = 0
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You are an E2E test planner")) {
      const given = input(asked)
      planned.push(given)
      log.push("plan")
      return {
        appUrl: given.appUrl,
        flows: [{
          name: "checkout",
          goal: given.productBrief,
          steps: ["add to cart"],
          assertions: ["total shown"],
          risk: "high"
        }],
        assumptions: []
      }
    }
    if (asked.includes("You are a Playwright test generator")) {
      const { plan, testDirectory } = input(asked)
      log.push(`generate in ${testDirectory}`)
      const flows: ReadonlyArray<{ readonly name: string }> = plan.flows
      return {
        files: flows.map((f) => ({ path: `${testDirectory}/${f.name}.spec.ts`, summary: f.name, flowNames: [f.name] })),
        commands: [],
        notes: "generated"
      }
    }
    if (asked.includes("You are a Playwright test healer")) {
      const { generatedTests, latestRun } = input(asked)
      const n = ++heals
      log.push(`heal ${n} <- ${latestRun.failures[0].message}`)
      return { ...generatedTests, notes: `heal ${n}` }
    }
    if (asked.includes("You are an E2E QA reporter")) {
      const { generatedAttempts, passed, runs } = input(asked)
      const attempts = (generatedAttempts as ReadonlyArray<{ readonly notes: string }>).map((a) => a.notes)
      const outcomes = (runs as ReadonlyArray<{ readonly passed: boolean }>).map((r) => r.passed)
      reported.push({ attempts, runs: outcomes, passed })
      log.push("report")
      return {
        status: passed ? "passed" : "failed",
        coverageSummary: `${attempts.length} attempts`,
        iterations: outcomes.length,
        artifacts: [],
        nextActions: passed ? [] : ["review the checkout selectors"]
      }
    }
    return undefined
  }
  const actions = layer({
    runTests: (request) =>
      Effect.sync(() => {
        ran.push(request)
        const n = ran.length
        const passed = n > failing
        log.push(`run ${request.generatedTests.notes}`)
        return {
          passed,
          command: request.command,
          total: 1,
          failed: passed ? 0 : 1,
          failures: passed ? [] : [{ file: request.generatedTests.files[0]!.path, message: `timeout ${n}` }],
          artifacts: passed ? [] : [`trace-${n}.zip`]
        }
      })
  })
  return { actions, answer, log, planned, ran, reported }
}

it.effect("heals a failing run and stops at the first passing one", () =>
  Effect.gen(function*() {
    const { actions, answer, log, planned, ran, reported } = script(1)
    const report = yield* Kit.run(PlaywrightTestAgent, { productBrief: "Shoppers can check out." }, {
      filename: join(directory, "heals.sqlite"),
      executionId: "playwright-heals",
      script: answer,
      actions
    })

    // The planner got the brief and the 0.x defaults.
    expect(planned).toEqual([{
      appUrl: "http://localhost:3000",
      productBrief: "Shoppers can check out.",
      seedTest: null,
      existingTestGlob: "tests/**/*.spec.{ts,tsx}"
    }])
    // The healer read the failed run; the second run ran the healed specs.
    expect(log).toEqual([
      "plan",
      "generate in tests/generated",
      "run generated",
      "heal 1 <- timeout 1",
      "run heal 1",
      "report"
    ])
    expect(ran[0]).toMatchObject({
      command: "npx playwright test tests/generated --trace retain-on-failure",
      appUrl: "http://localhost:3000"
    })
    expect(reported).toEqual([{ attempts: ["generated", "heal 1"], runs: [false, true], passed: true }])
    expect(report).toMatchObject({ status: "passed", iterations: 2 })
  }))

it.effect("heals after the last failing round and reports every attempt", () =>
  Effect.gen(function*() {
    const { actions, answer, log, reported } = script(99)
    const report = yield* Kit.run(PlaywrightTestAgent, { productBrief: "Shoppers can check out.", maxIterations: 2 }, {
      filename: join(directory, "exhausted.sqlite"),
      executionId: "playwright-exhausted",
      script: answer,
      actions
    })

    // Two rounds, each healed, the last heal included, as in 0.x.
    expect(log).toEqual([
      "plan",
      "generate in tests/generated",
      "run generated",
      "heal 1 <- timeout 1",
      "run heal 1",
      "heal 2 <- timeout 2",
      "report"
    ])
    expect(reported).toEqual([{ attempts: ["generated", "heal 1", "heal 2"], runs: [false, false], passed: false }])
    expect(report).toMatchObject({ status: "failed", iterations: 2, nextActions: ["review the checkout selectors"] })
  }))

it.effect("reports without healing when the first run passes, reading the story as the brief", () =>
  Effect.gen(function*() {
    const { actions, answer, log, planned, ran, reported } = script(0)
    const report = yield* Kit.run(PlaywrightTestAgent, {
      story: "As a shopper I can pay.",
      appUrl: "http://127.0.0.1:4173",
      seedTest: "tests/seed.spec.ts",
      testDirectory: "e2e",
      testCommand: "npx playwright test e2e"
    }, {
      filename: join(directory, "first-pass.sqlite"),
      executionId: "playwright-first-pass",
      script: answer,
      actions
    })

    expect(planned[0]).toMatchObject({
      appUrl: "http://127.0.0.1:4173",
      productBrief: "As a shopper I can pay.",
      seedTest: "tests/seed.spec.ts"
    })
    expect(log).toEqual(["plan", "generate in e2e", "run generated", "report"])
    expect(ran[0]?.command).toBe("npx playwright test e2e")
    expect(ran[0]?.generatedTests.files.map((f) => f.path)).toEqual(["e2e/checkout.spec.ts"])
    expect(reported).toEqual([{ attempts: ["generated"], runs: [true], passed: true }])
    expect(report.iterations).toBe(1)
  }))
