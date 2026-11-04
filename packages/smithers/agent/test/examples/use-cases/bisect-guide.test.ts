import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BisectGuide, layer, maxIterations, TestCommit } from "../../../examples/use-cases/bisect-guide.vibe"
import * as Kit from "../../../examples/use-cases/kit.vibe"

const directory = mkdtempSync(join(tmpdir(), "bisect-guide-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/**
 * A history of commits `c0`, `c1`, ... whose test fails from index `culprit`
 * on (or times out at every commit when `culprit` is `"flaky"`), and an
 * adjudicator that reads the bounds and exit code it is handed: exit 0 is
 * good, 1 is bad, anything else is skip with the bounds unchanged. The
 * adjudicator names the culprit once the bounds meet. Each tested midpoint is
 * recorded, and each adjudication with how many earlier verdicts it was shown.
 */
const script = (culprit: number | "flaky") => {
  const tested: Array<string> = []
  const shown: Array<number> = []
  const answer: Kit.Script = (asked) => {
    if (!asked.includes("You are a bisect adjudicator")) return undefined
    const [, low, high, mid] = /\nBounds: low (\d+), high (\d+), mid (\d+)/.exec(asked)!.map(Number)
    const exitCode = Number(/\nExit code: (\d+)/.exec(asked)![1])
    shown.push(JSON.parse(/\nPrevious verdicts: (.+)/.exec(asked)![1]!).length)
    const verdict = exitCode === 0 ? "good" : exitCode === 1 ? "bad" : "skip"
    const nextLow = verdict === "good" ? mid! + 1 : low!
    const nextHigh = verdict === "bad" ? mid! : high!
    const culpritFound = nextLow >= nextHigh
    return {
      verdict,
      confidence: verdict === "skip" ? 0.4 : 0.9,
      reasoning: `exit ${exitCode}`,
      nextLow,
      nextHigh,
      culpritFound,
      culpritSha: culpritFound ? `c${nextLow}` : null
    }
  }
  // The deterministic test step: no checkout, the outcome comes from the index.
  const runner = TestCommit.toLayer(({ high, low, mid, repoPath, testCommand }) =>
    Effect.sync(() => {
      tested.push(`${mid} in ${low}..${high}`)
      const exitCode = culprit === "flaky" ? 124 : mid >= culprit ? 1 : 0
      return {
        sha: `c${mid}`,
        low,
        high,
        mid,
        testOutput: `${repoPath}: ${testCommand} exited ${exitCode}`,
        exitCode
      }
    })
  )
  return { answer, shown, tested, actions: Layer.mergeAll(layer, runner) }
}

it.effect("narrows the bounds each step until the adjudicator names the culprit", () =>
  Effect.gen(function*() {
    const { actions, answer, shown, tested } = script(5)
    const output = yield* Kit.run(BisectGuide, { repoPath: "/repo", testCommand: "make check", commitCount: 8 }, {
      filename: join(directory, "found.sqlite"),
      executionId: "bisect-guide-found",
      script: answer,
      actions
    })

    // Each step tested the midpoint of the bounds the previous verdict set,
    // and each adjudicator was shown every verdict before it.
    expect(tested).toEqual(["3 in 0..7", "5 in 4..7", "4 in 4..5"])
    expect(shown).toEqual([0, 1, 2])
    expect(output).toEqual({ culpritSha: "c5", totalSteps: 3, summary: "Culprit c5 found after 3 bisect steps." })
  }))

it.effect("returns the last verdict after twenty ambiguous steps", () =>
  Effect.gen(function*() {
    const { actions, answer, shown, tested } = script("flaky")
    const output = yield* Kit.run(BisectGuide, { repoPath: "/repo", testCommand: "make check", commitCount: 8 }, {
      filename: join(directory, "exhausted.sqlite"),
      executionId: "bisect-guide-exhausted",
      script: answer,
      actions
    })

    // Every run timed out, so every verdict was skip and the bounds never moved.
    expect(tested).toEqual(Array.from({ length: maxIterations }, () => "3 in 0..7"))
    expect(shown.at(-1)).toBe(maxIterations - 1)
    expect(output).toEqual({ culpritSha: null, totalSteps: 20, summary: "No culprit found after 20 bisect steps." })
  }))
